import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass';
import { enqueueRefund } from '@/lib/refunds';
import { buildReceiptEmail } from '@/lib/receiptEmail';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// ⚡ STUCK-PROCESSING RECONCILIATION ⚡
//
// Every money route (contract-call /api/pay, x402 /api/pay/x402, the DeAI agent's direct
// relayer payment, and the scheduler's autonomous relayer payment) follows the same pattern:
// atomically lock a transaction row PENDING -> PROCESSING, THEN call executeVend() (which
// calls VTpass). If the serverless function crashes, times out, or the connection drops
// ANYWHERE between the lock and the vend completing, the row is stuck at PROCESSING forever
// — with the user's crypto already moved (on-chain success already confirmed before the lock
// in every one of those routes) and VTpass possibly never even contacted.
//
// Nothing else in the codebase catches this:
//   - cleanupStalePreflights only ever touches PENDING rows with a `preflight_` tx_hash —
//     it explicitly never touches PROCESSING or a real tx_hash.
//   - The Alchemy webhook's fast pre-check treats ANY non-PENDING status (including a
//     stuck PROCESSING) as "already handled" and does nothing further.
//   - The VTpass status webhook only fires if VTpass itself calls back — if our server
//     crashed before ever reaching the VTpass /pay call, VTpass has nothing to call back about.
//
// This sweep finds those stuck rows and reconciles them SAFELY:
//   1. Ask VTpass /requery (read-only, no side effects, cannot double-vend) what actually
//      happened to this request_id.
//   2. delivered/successful -> complete it now, exactly like /api/requery's manual path
//      (atomic claim guards against a race with a webhook finishing it in parallel).
//   3. failed -> mark FAILED_VENDING and auto-enqueue the SAME refund path every other
//      failure path already uses (idempotent by tx_hash).
//   4. VTpass has no record of this request_id at all (our crash happened BEFORE the /pay
//      call ever went out) -> genuinely ambiguous, so this does NOT guess. It alerts the
//      operator with everything needed to act from the admin dashboard (Requery / manual
//      refund) rather than risk a double-vend from a blind automatic retry.

const STUCK_MINUTES = 5; // executeVend normally completes in seconds — 5 min is a generous floor
let lastRun = 0;
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export async function reconcileStuckProcessing(opts: { force?: boolean } = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRun < MIN_INTERVAL_MS) {
    return { ok: true, skipped: true, reconciled: 0, alerted: 0 };
  }
  lastRun = now;

  const cutoff = new Date(now - STUCK_MINUTES * 60 * 1000).toISOString();

  const { data: stuck, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('status', 'PROCESSING')
    .not('tx_hash', 'like', 'preflight_%')
    .lt('created_at', cutoff)
    .limit(25); // bounded — a real backlog this size means something else is badly wrong

  if (error) {
    console.error('[Reconcile] load failed:', error.message);
    return { ok: false, error: error.message, reconciled: 0, alerted: 0 };
  }
  if (!stuck || stuck.length === 0) return { ok: true, reconciled: 0, alerted: 0 };

  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';

  let reconciled = 0;
  let alerted = 0;

  for (const record of stuck as any[]) {
    try {
      if (!record.request_id) {
        await sendTelegramAlert(
          `🚨 *STUCK PAYMENT — NO REQUEST ID*\n\nTx \`${record.tx_hash}\` has been PROCESSING for over ${STUCK_MINUTES} min with no request_id to requery. Funds are on-chain; nothing was ever sent to VTpass. Needs manual review in the admin dashboard.\n\n👤 Wallet: \`${record.wallet_address || 'unknown'}\`\n💰 ${record.amount_usdt} ${record.token_used || 'USD₮'} (₦${record.amount_naira})`
        );
        alerted++;
        continue;
      }

      const requeryRes = await fetch(`${baseUrl}/requery`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ request_id: record.request_id }),
      });
      const requeryData = await requeryRes.json();
      const actualStatus = requeryData?.content?.transactions?.status;

      if (actualStatus === 'delivered' || actualStatus === 'successful') {
        let dbPurchasedCode =
          requeryData.purchased_code || requeryData.token ||
          requeryData.content?.transactions?.token || requeryData.content?.transactions?.purchased_code ||
          requeryData.Pin || null;
        if (!dbPurchasedCode && (record.service_category === 'ELECTRICITY' || record.service_category === 'EDUCATION')) {
          const tokenMatch = JSON.stringify(requeryData).match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i);
          if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, '');
        }
        const vendedUnits = requeryData.units || requeryData.content?.transactions?.units || null;

        const requiresCode = record.service_category === 'ELECTRICITY' || record.service_category === 'EDUCATION';
        if (requiresCode && !dbPurchasedCode) {
          // Delivered per VTpass, but the token/PIN isn't in the response yet — leave it for
          // the next sweep rather than completing without the thing the user actually needs.
          continue;
        }

        // Atomic claim — guards against a race with the VTpass webhook or an admin-triggered
        // requery finishing this same row in parallel.
        const { data: claimed } = await supabase
          .from('transactions')
          .update({ status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits?.toString() })
          .eq('id', record.id)
          .eq('status', 'PROCESSING')
          .select();

        if (!claimed || claimed.length === 0) continue; // already resolved elsewhere

        const alertTokenRef = dbPurchasedCode || requeryData.content?.transactions?.transactionId || 'Success';
        const notifications: any[] = [];

        notifications.push(
          sendTelegramAlert(
            `✅ *RECOVERED STUCK PAYMENT*\n\nThis was PROCESSING for >${STUCK_MINUTES} min (server likely crashed mid-vend) — VTpass confirms it actually delivered. Completed now via reconciliation.\n\n🛒 *Product:* ${record.network} ${record.service_category}\n💰 ₦${record.amount_naira} (${record.amount_usdt} ${record.token_used || 'USD₮'})\n👤 *User:* ${record.account_number}\n🧾 *Ref:* ${alertTokenRef}\n🔗 \`${record.tx_hash}\``
          )
        );

        if (record.service_category === 'ELECTRICITY' || record.service_category === 'EDUCATION') {
          const typeLabel = record.service_category === 'ELECTRICITY' ? 'Token' : 'PIN';
          notifications.push(
            sendAbaPaySms(record.phone || record.account_number, `AbaPay: Your ${record.network || record.service_category} ${typeLabel} is ${alertTokenRef}. Amount: N${record.amount_naira}. Thank you.`)
          );
        }

        if (record.customer_email) {
          notifications.push(resend.emails.send({
            from: 'AbaPay Receipts <receipts@abapays.com>',
            to: record.customer_email,
            replyTo: 'support@abapays.com',
            subject: `AbaPay Receipt - ${record.network} ${record.service_category}`,
            html: buildReceiptEmail({
              displayAmount: record.display_amount || `₦${Number(record.amount_naira).toLocaleString()}`,
              serviceLabel: `${record.network || ''} ${record.service_category || ''}`.trim(),
              accountNumber: record.account_number,
              cryptoCharged: `${record.amount_usdt} ${record.token_used || 'USD₮'}`,
              txHash: record.tx_hash,
              purchasedCode: dbPurchasedCode,
              units: vendedUnits ? String(vendedUnits) : null,
              referenceId: record.request_id,
              customerName: record.customer_name,
              customerAddress: record.customer_address,
            }),
          }));
        }

        const effectiveRate = (Number(record.amount_naira) + Number(record.fee_naira || 0)) / Number(record.amount_usdt);
        const points = Number.isFinite(effectiveRate) && effectiveRate > 0 ? Number((record.amount_naira / effectiveRate).toFixed(2)) : 0;
        if (points > 0 && record.wallet_address) {
          notifications.push(supabase.rpc('award_transaction_points', { target_wallet: record.wallet_address.toLowerCase(), points_to_add: points }));
        }

        await Promise.allSettled(notifications);
        reconciled++;
      } else if (actualStatus === 'failed' || actualStatus === 'reversed') {
        const { data: claimed } = await supabase
          .from('transactions')
          .update({ status: 'FAILED_VENDING', error_code: 'RECONCILED_FAILED', api_response: 'VTpass confirmed failure via reconciliation requery' })
          .eq('id', record.id)
          .eq('status', 'PROCESSING')
          .select();

        if (!claimed || claimed.length === 0) continue;

        try {
          await enqueueRefund({
            transactionId: record.id,
            txHash: record.tx_hash,
            walletAddress: record.wallet_address || '',
            tokenUsed: record.token_used || 'USD₮',
            amountCrypto: Number(record.amount_usdt),
            amountNaira: Number(record.amount_naira),
            blockchain: record.blockchain || 'CELO',
            reason: 'Stuck PROCESSING row reconciled — VTpass confirmed the vend failed',
            vtpassError: JSON.stringify(requeryData).slice(0, 300),
            serviceCategory: record.service_category,
            sourceChannel: record.source_channel || 'WEB',
          });
        } catch (refundErr) {
          console.error('[Reconcile] Failed to queue refund:', refundErr);
        }

        await sendTelegramAlert(
          `❌ *RECOVERED STUCK PAYMENT — VEND FAILED*\n\nThis was PROCESSING for >${STUCK_MINUTES} min. VTpass confirms it never delivered — refund auto-queued.\n\n🛒 *Product:* ${record.network} ${record.service_category}\n👤 *User:* ${record.account_number}\n🔗 \`${record.tx_hash}\``
        );
        reconciled++;
      } else {
        // Neither delivered nor failed — either still genuinely processing at VTpass (leave
        // it, next sweep will re-check), or VTpass has no record of this request_id at all
        // (our crash happened before the /pay call ever went out). Can't safely tell which
        // from here without risking a double-vend, so this alerts rather than guesses.
        const vtpassKnowsNothing = !requeryData?.content && !requeryData?.response_description;
        if (vtpassKnowsNothing) {
          await sendTelegramAlert(
            `🚨 *STUCK PAYMENT — VTPASS HAS NO RECORD*\n\nTx \`${record.tx_hash}\` has been PROCESSING for over ${STUCK_MINUTES} min. Funds are already on-chain, but VTpass's requery shows no record of request_id \`${record.request_id}\` — our server likely crashed BEFORE ever calling VTpass. This needs a manual decision in the admin dashboard: retry the vend, or refund.\n\n👤 Wallet: \`${record.wallet_address || 'unknown'}\`\n💰 ${record.amount_usdt} ${record.token_used || 'USD₮'} (₦${record.amount_naira})\n🛒 ${record.network} ${record.service_category}`
          );
          alerted++;
        }
        // else: genuinely still processing at VTpass — leave alone, checked again next sweep.
      }
    } catch (err: any) {
      console.error('[Reconcile] error processing stuck row:', record.tx_hash, err?.message);
    }
  }

  return { ok: true, reconciled, alerted };
}
