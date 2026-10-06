import { NextResponse, after } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass';
import { Resend } from 'resend';
import { normalizePurchasedCode, issuesTokenOrPin } from '@/lib/purchasedCode';
import { buildReceiptEmail } from '@/lib/receiptEmail';
import { recordLateDelivery, recordLateFailure } from '@/lib/providerOutcome';
import { pointsForPayment } from '@/lib/points';
import { errorMessage } from '@/lib/errors';
import type { VtpassPush, VtpassReply } from '@/lib/vtpassReply';

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

// ⚡ THE ACKNOWLEDGEMENT VTPASS ACTUALLY LOOKS FOR ⚡
// VTpass does not just check for a 2xx — it parses the body and expects
// `{"response": "success"}`. Anything else (we used to send `{received: true}`)
// is read as "the partner never acknowledged", which makes VTpass retry the same
// notification repeatedly and eventually flags the endpoint as unhealthy.
// Every exit path below MUST go through this.
const ack = () => NextResponse.json({ response: 'success' });

export async function POST(req: Request) {
  let body: VtpassPush;

  try {
    body = await req.json();
  } catch {
    // Unparseable body — still acknowledge; retrying it won't help either side.
    return ack();
  }

  // ⚡ ACKNOWLEDGE FIRST, WORK AFTER ⚡
  // VTpass asks that the endpoint stay lightweight and reply promptly, without
  // heavy operations before responding. Our processing is anything but light: an
  // authenticated server-to-server requery, a DB write, then Telegram + SMS + email
  // + points. `after()` runs that once the response has already been flushed, so
  // VTpass gets its acknowledgement immediately and stops retrying.
  after(async () => {
    try {
      await processNotification(body);
    } catch (error) {
      console.error("VTpass webhook processing error:", errorMessage(error));
    }
  });

  return ack();
}

async function processNotification(body: VtpassPush) {
    // VTpass sometimes wraps the payload in "data", and sometimes sends it raw. We handle both.
    const payload = body.data || body;
    const { requestId } = payload;

    if (!requestId) {
        console.log("VTpass webhook: no Request ID in payload.");
        return;
    }

    // 1. Fetch the existing pending transaction from the database
    const { data: txData, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (fetchError || !txData) {
       console.log("Webhook: Transaction not found for ID:", requestId);
       return;
    }

    // 🔐 ANTI-FORGERY CHECK: This webhook is unauthenticated, so we NEVER trust the
    // pushed payload. We confirm the real status server-to-server with VTpass
    // (authenticated with our API keys) before updating anything.
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    let confirmedPayload: VtpassReply;
    let confirmedStatus: string | null = null;
    try {
        const confirmRes = await fetch(`${baseUrl}/requery`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ request_id: requestId })
        });
        confirmedPayload = await confirmRes.json();
        confirmedStatus = confirmedPayload.content?.transactions?.status || null;
    } catch {
        // If we cannot confirm with the provider, do not act on an unauthenticated push.
        console.log("Webhook: could not confirm status with provider. Push ignored.");
        return;
    }

    const trustedTx = confirmedPayload?.content?.transactions || {};

    // --- SCENARIO 1: DELAYED SUCCESS (CONFIRMED BY VTPASS) ---
    if (confirmedStatus === 'delivered' || confirmedStatus === 'successful') {

      // If it's already marked success, avoid duplicate notifications
      if (txData.status === 'SUCCESS') return;

      // Extract the delayed Token, PIN, or Units from the CONFIRMED payload only
      // normalizePurchasedCode: VTpass sends the placeholder "Token : N/A" instead of omitting
      // the field, which was being stored as though it were a real meter token.
      let dbPurchasedCode = normalizePurchasedCode(confirmedPayload.purchased_code || confirmedPayload.token || confirmedPayload.tokens || confirmedPayload.Pin || trustedTx.token || trustedTx.purchased_code);
      const vendedUnits = confirmedPayload.units || trustedTx.units || trustedTx.unit || null;

      // Aggressive Token Regex fallback for Electricity
      if (!dbPurchasedCode && txData.service_category === 'ELECTRICITY') {
          const rawPayloadString = JSON.stringify(confirmedPayload);
          const tokenMatch = rawPayloadString.match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i);
          if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, '');
      }

      const alertTokenRef = dbPurchasedCode || trustedTx.transactionId || requestId || "Success";

      // 🔐 ATOMIC, STATE-AWARE CLAIM — only one execution records the delivery and notifies, and
      // never over a refund. This used to be `.neq('status', 'SUCCESS')`, which also flipped a
      // FAILED_VENDING or REFUNDED row to SUCCESS and texted the token to a customer whose money
      // was already coming back (ABAPAY_FULL_AUDIT.md P-5). See src/lib/providerOutcome.ts.
      const outcome = await recordLateDelivery(txData, { purchased_code: dbPurchasedCode, units: vendedUnits?.toString() ?? null });
      if (outcome !== 'DELIVERED') return;

      // ⚡ TRIGGER ALL DELAYED NOTIFICATIONS ⚡
      const notifications = [];

      notifications.push(
        sendTelegramAlert(`✅ *DELAYED SALE SUCCESS (WEBHOOK)*\n🛒 *Product:* ${txData.network} ${txData.service_category}\n💰 *Naira:* ₦${txData.amount_naira}\n👤 *User:* ${txData.account_number}\n🧾 *Ref/Token:* ${alertTokenRef}`)
      );

      // ⚡ ONLY SEND SMS FOR TOKENS/PINS TO SAVE COST ⚡
      // Postpaid excluded — see issuesTokenOrPin; a postpaid meter never gets a token, so
      // there is no code to deliver and the old text promised one that does not exist.
      if (issuesTokenOrPin(txData.service_category, txData.variation_code)) {
        const typeLabel = txData.service_category === 'ELECTRICITY' ? 'Token' : 'PIN';
        const networkDisplay = txData.network || txData.service_category;

        // Use txData.phone first! Fallback to account_number for data/airtime
        const smsTarget = txData.phone || txData.account_number;

        notifications.push(
          sendAbaPaySms(smsTarget, `AbaPay: Your ${networkDisplay} ${typeLabel} is ${alertTokenRef}. Amount: N${txData.amount_naira}. Thank you.`)
        );
      }

      if (txData.customer_email) {
        // 🔴 WAS A HAND-ROLLED EMAIL — the exact drift src/lib/receiptEmail.ts was created to
        // end. Every other vend path (/api/pay, /api/webhook, /api/requery, reconcileStuck)
        // already used the shared premium template, so whether a customer got the branded
        // receipt or this stripped-down one came down to WHICH path happened to complete the
        // vend — and a delayed VTpass push is exactly the case where they'd get the plain one,
        // with no provider logo, no customer name and no meter address.
        const emailPromise = resend.emails.send({
          from: 'AbaPay Receipts <receipts@abapays.com>',
          to: txData.customer_email,
          replyTo: 'support@abapays.com',
          subject: `AbaPay Receipt - ${txData.network} ${txData.service_category}`,
          html: buildReceiptEmail({
            displayAmount: txData.display_amount || `₦${Number(txData.amount_naira).toLocaleString()}`,
            serviceLabel: `${txData.network || ''} ${txData.service_category || ''}`.trim(),
            serviceId: txData.service_id,
            serviceCategory: txData.service_category,
            variationCode: txData.variation_code,
            accountNumber: txData.account_number,
            cryptoCharged: `${txData.amount_usdt} ${txData.token_used || 'USD₮'}`,
            txHash: txData.tx_hash,
            purchasedCode: dbPurchasedCode,
            units: vendedUnits ? String(vendedUnits) : null,
            referenceId: txData.request_id,
            customerName: txData.customer_name,
            customerAddress: txData.customer_address,
            isDelayed: true,
          }),
        });
        notifications.push(emailPromise);
      }

      // Distribute AbaPoints
      const earnedPoints = pointsForPayment(txData);
      if (earnedPoints > 0 && txData.wallet_address) {
          notifications.push(supabase.rpc('award_transaction_points', {
              target_wallet: txData.wallet_address.toLowerCase(),
              points_to_add: earnedPoints
          }));
      }

      await Promise.allSettled(notifications);
      return;
    }

    // --- SCENARIO 2: TRANSACTION REVERSAL (CONFIRMED BY VTPASS) ---
    if (confirmedStatus === 'reversed' || confirmedStatus === 'failed') {
       // The customer paid and has nothing. recordLateFailure moves the row (SUCCESS ->
       // REVERSED_NEEDS_REFUND, PENDING/PROCESSING -> FAILED_VENDING) and QUEUES the refund, so it
       // appears in the Ops refund tab — this used to only alert, leaving the refund to memory.
       const reason = `VTpass ${confirmedStatus}: ${confirmedPayload.response_description || 'Provider Reversal'}`;
       const queued = await recordLateFailure(txData, reason);
       if (queued === 'ALREADY') return;

       const alertMessage = `⚠️ *VTPASS REVERSAL ALERT*\n\nVTpass ${confirmedStatus === 'reversed' ? 'reversed' : 'failed'} a transaction after the fact and refunded our Naira float.\n\n🛒 *Req ID:* ${requestId}\n💰 *Naira:* ₦${txData.amount_naira}\n🛑 *Reason:* ${confirmedPayload.response_description || 'Provider Reversal'}\n\n💸 A crypto refund has been queued — approve it in Admin → Refunds.\n👤 *User Wallet:* \`${txData.wallet_address || 'Unknown'}\`\n🪙 *Crypto Owed:* ${txData.amount_usdt} ${txData.token_used || ''}`;

       await sendTelegramAlert(alertMessage);
       return;
    }

    // Any other status (still pending, etc.) needs no action — the acknowledgement
    // has already gone out, so VTpass won't retry it.
    console.log(`VTpass webhook: unhandled status '${confirmedStatus}' for ${requestId}.`);
}
