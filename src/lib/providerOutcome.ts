import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { enqueueRefund } from '@/lib/refunds';

// ⚡ LATE PROVIDER OUTCOMES — what to do when VTpass settles an order AFTER we already decided.
//
// Two paths learn an order's outcome after the fact: the VTpass push (src/app/api/webhook/vtpass)
// and the admin's manual requery (src/app/api/requery). Both used to claim the row with
// `.neq('status', 'SUCCESS')`, i.e. from ANY other status (ABAPAY_FULL_AUDIT.md P-5):
//
//   • a late "delivered" on a row already FAILED_VENDING or REFUNDED flipped it to SUCCESS and
//     texted the customer the token — the customer got the service AND the refund;
//   • a late "reversed/failed" set REVERSED_NEEDS_REFUND (push) or FAILED_VENDING (requery) and
//     alerted, but never reached refund_queue — so the Ops refund tab never saw it.
//
// Both now go through here, where every transition is conditional on the state that was read.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come from the untyped Supabase client
type TxRow = Record<string, any>;

export type LateDelivery =
  | 'DELIVERED'  // this call moved the row to SUCCESS — the caller sends the customer's receipt
  | 'ALREADY'    // someone else already recorded it (or it was never ours to move) — do nothing
  | 'FLAGGED';   // delivered, but money already went (or is going) back — an operator decides

async function alert(text: string) {
  try { await sendTelegramAlert(text); } catch { /* alerting never changes an outcome */ }
}

/**
 * The provider says this order WAS delivered. Record it — unless the customer is already being
 * refunded, in which case delivering the token as well would pay them twice.
 */
export async function recordLateDelivery(row: TxRow, fields: { purchased_code?: string | null; units?: string | null }): Promise<LateDelivery> {
  const done = { status: 'SUCCESS', purchased_code: fields.purchased_code ?? null, units: fields.units ?? null };

  if (row.status === 'SUCCESS') return 'ALREADY';

  if (row.status === 'PENDING' || row.status === 'PROCESSING') {
    const { data } = await supabase.from('transactions').update(done).eq('id', row.id).in('status', ['PENDING', 'PROCESSING']).select('id');
    return data && data.length ? 'DELIVERED' : 'ALREADY';
  }

  if (row.status === 'FAILED_VENDING') {
    // The vend was written off and a refund may be queued. Withdraw the refund — but only while
    // it is still PENDING and no payout has been broadcast for it (refund_tx_hash is where an
    // operator's in-flight refundUser() is parked). REJECTED is the existing "the vend actually
    // succeeded on retry" state the Ops tab already knows.
    const { data: withdrawn } = await supabase.from('refund_queue')
      .update({ status: 'REJECTED', notes: 'Provider delivered after the vend was marked failed — refund withdrawn automatically.', approved_by: 'system' })
      .eq('tx_hash', row.tx_hash).eq('status', 'PENDING').is('refund_tx_hash', null)
      .select('id');

    let clearToDeliver = !!(withdrawn && withdrawn.length);
    if (!clearToDeliver) {
      const { data: refund } = await supabase.from('refund_queue').select('status, refund_tx_hash').eq('tx_hash', row.tx_hash).maybeSingle();
      // No refund was ever queued, or an operator already rejected it: nothing is going back.
      clearToDeliver = !refund || (refund.status === 'REJECTED' && !refund.refund_tx_hash);
    }

    if (clearToDeliver) {
      const { data } = await supabase.from('transactions').update(done).eq('id', row.id).eq('status', 'FAILED_VENDING').select('id');
      if (data && data.length) {
        if (withdrawn?.length) {
          await alert(`↩️ *REFUND WITHDRAWN — PROVIDER DELIVERED LATE*\nVTpass delivered \`${row.request_id}\` after it was marked failed. The queued refund was withdrawn and the customer gets their receipt.\n👤 ${row.account_number} · ${row.network} ${row.service_category}\n🔗 \`${row.tx_hash}\``);
        }
        return 'DELIVERED';
      }
      return 'ALREADY';
    }
  }

  // FAILED_VENDING with a refund already paid / being paid, REFUNDED, REVERSED_NEEDS_REFUND, or
  // anything else terminal: the provider delivered AND the money is going (or went) back. Don't
  // send the token, don't move the status — record what happened and put it in front of a human.
  await supabase.from('transactions').update({
    error_code: 'DELIVERED_AFTER_REFUND',
    api_response: `Provider reports this order DELIVERED, but the transaction is ${row.status} and its refund is paid or in flight. Not re-delivered — decide by hand.`,
  }).eq('id', row.id).eq('status', row.status);
  await alert(`🚨 *DELIVERED AFTER REFUND*\nVTpass reports \`${row.request_id}\` delivered, but the transaction is *${row.status}* and the customer's refund is paid or in flight. The token was NOT sent. Decide by hand: reclaim, or let it stand.\n👤 ${row.account_number} · ₦${row.amount_naira}\n🔗 \`${row.tx_hash}\``);
  return 'FLAGGED';
}

/**
 * The provider says this order FAILED or was REVERSED. The customer paid and has nothing, so
 * they are owed a refund — queued here, not just announced.
 */
export async function recordLateFailure(row: TxRow, detail: string): Promise<'QUEUED' | 'ALREADY'> {
  let moved = false;
  if (row.status === 'SUCCESS') {
    // Delivered, then reversed by the provider (VTpass refunded OUR float). Kept distinct from a
    // plain failure so the ledger shows the reversal happened after a success.
    const { data } = await supabase.from('transactions').update({ status: 'REVERSED_NEEDS_REFUND', api_response: detail.slice(0, 500) })
      .eq('id', row.id).eq('status', 'SUCCESS').select('id');
    moved = !!(data && data.length);
  } else if (row.status === 'PENDING' || row.status === 'PROCESSING') {
    const { data } = await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'PROVIDER_FAILED_LATE', api_response: detail.slice(0, 500) })
      .eq('id', row.id).in('status', ['PENDING', 'PROCESSING']).select('id');
    moved = !!(data && data.length);
  } else if (row.status !== 'FAILED_VENDING' && row.status !== 'REVERSED_NEEDS_REFUND') {
    return 'ALREADY'; // REFUNDED / EXPIRED / ... — nothing is owed any more
  }

  // refund_queue.tx_hash is UNIQUE, so this is idempotent: a FAILED_VENDING row that already has
  // its refund queued just answers "already queued".
  const q = await enqueueRefund({
    transactionId: row.id,
    txHash: row.tx_hash,
    walletAddress: row.wallet_address || '',
    tokenUsed: row.token_used || 'USD₮',
    amountCrypto: Number(row.amount_usdt),
    amountNaira: Number(row.amount_naira),
    blockchain: row.blockchain || 'CELO',
    reason: row.status === 'SUCCESS' ? 'Provider reversed a delivered order' : 'Provider reported the order failed after the fact',
    vtpassError: detail.slice(0, 300),
    userMessage: "This one didn't go through in the end.",
    serviceCategory: row.service_category,
    sourceChannel: row.source_channel || 'WEB',
  });
  return moved || q.queued ? 'QUEUED' : 'ALREADY';
}
