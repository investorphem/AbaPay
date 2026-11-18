import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { vendInputFromRow } from '@/lib/vendInput';
import { getHeaders } from '@/lib/vtpass';
import { explorerTxUrl } from '@/lib/chain';
import { paymentLandedOnChain } from '@/lib/refundEligibility';
import { proveOrderPaid } from '@/lib/orderPaymentProof';
import { vtpassHasNoRecord, type VtpassReply } from '@/lib/vtpassReply';
import { verifyNimPayment, LUNA_PER_NIM } from '@/lib/nimiq';

// ⚡ ADMIN: RETRY DELIVERY instead of refunding.
//
// A failed VTpass order sits in Ops → Refunds. When the failure was on our side and is fixed (e.g.
// 2026-11-18: rotated VTpass keys gave 087 INVALID CREDENTIALS until the deploy picked them up), the
// customer would rather get what they paid for than a refund. This sends the SAME stored order
// (src/lib/vendInput.ts, never anything from the request) to VTpass again under a new request_id.
//
// Never pays twice, never vends twice:
//   1. the payment must be proven on chain NOW, never inferred from a hash's format: Celo/Base by the
//      vault's PaymentReceived (proveOrderPaid), NIM by the Nimiq transaction itself paying the
//      treasury at least the order amount from the ordering wallet (verifyNimPayment). The admin
//      only sees the button for rows that pass this (GET /api/admin/refunds), and it runs again here;
//   2. VTpass is asked about the OLD request_id first: delivered or still pending = no retry;
//   3. the refund row moves PENDING → RETRYING in one conditional update, so it can't be refunded
//      (or retried) while delivery is in flight;
//   4. the order moves FAILED_VENDING → PROCESSING in one conditional update with a fresh
//      request_id and the dispatch stamp cleared, so exactly one caller sends it.
// executeVend then records the outcome on the order (the customer's history reads it) and sends the
// receipt. If it fails again, enqueueRefund puts the RETRYING row back to PENDING (src/lib/refunds.ts).

export type RetryOutcome =
  | { ok: true; status: 'SUCCESS' | 'TIMEOUT' | 'FAILED_VENDING'; message: string }
  | { ok: false; httpStatus: number; message: string };

const VENDABLE_ELSEWHERE = new Set(['BANK']); // Monnify transfers have their own requery path

async function oldRequestState(requestId: string | null): Promise<'none' | 'failed' | 'delivered' | 'pending' | 'unknown'> {
  if (!requestId) return 'none';
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
  try {
    const res = await fetch(`${baseUrl}/requery`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ request_id: requestId }), signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json()) as VtpassReply;
    // 087 etc.: VTpass didn't answer about the transaction at all; can't decide.
    if (['087', '083'].includes(String(reply?.code ?? ''))) return 'unknown';
    if (vtpassHasNoRecord(reply)) return 'none';
    const status = String(reply?.content?.transactions?.status || '').toLowerCase();
    if (status === 'delivered' || status === 'successful') return 'delivered';
    if (['failed', 'reversed'].includes(status)) return 'failed';
    if (status) return 'pending';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

type OrderRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped Supabase row

/**
 * Can this order be delivered instead of refunded? Only a FAILED_VENDING, unrefunded, non-bank order
 * whose payment the chain proves reached the vault (Celo/Base) or the treasury (NIM). An undecided
 * chain is a no: the button is never offered on a guess.
 */
export async function deliverableOrder(tx: OrderRow | null): Promise<{ ok: boolean; reason: string }> {
  if (!tx) return { ok: false, reason: 'The order for this refund was not found.' };
  if (tx.status !== 'FAILED_VENDING' || tx.refund_hash) {
    return { ok: false, reason: `This order is ${tx.refund_hash ? 'already refunded' : tx.status} — only a failed delivery can be retried.` };
  }
  if (VENDABLE_ELSEWHERE.has(String(tx.service_category || '').toUpperCase())) {
    return { ok: false, reason: 'Bank transfers are retried through Monnify, not here.' };
  }
  if (!paymentLandedOnChain(tx)) return { ok: false, reason: 'This order was never paid on chain — nothing to deliver.' };
  if (String(tx.blockchain || '').toUpperCase() === 'NIMIQ') {
    const proof = await verifyNimPayment(String(tx.tx_hash), {
      minLuna: Math.round(Number(tx.amount_usdt) * LUNA_PER_NIM), payer: tx.wallet_address,
    });
    return proof.ok
      ? { ok: true, reason: 'The treasury received this payment on the Nimiq chain.' }
      : { ok: false, reason: `Payment not proven on the Nimiq chain: ${proof.code} — ${proof.detail}` };
  }
  const proof = await proveOrderPaid(tx as Parameters<typeof proveOrderPaid>[0]);
  return proof.status === 'PAID'
    ? { ok: true, reason: proof.detail }
    : { ok: false, reason: `Payment not proven on chain: ${proof.detail}` };
}

/** The order a refund row belongs to. */
export async function orderForRefund(refund: { transaction_id?: string | null; tx_hash: string }): Promise<OrderRow | null> {
  const q = refund.transaction_id
    ? supabase.from('transactions').select('*').eq('id', refund.transaction_id)
    : supabase.from('transactions').select('*').eq('tx_hash', refund.tx_hash);
  const { data } = await q.maybeSingle();
  return data ?? null;
}

export async function retryDelivery(refundId: string, admin: string): Promise<RetryOutcome> {
  const { data: refund } = await supabase.from('refund_queue').select('*').eq('id', refundId).maybeSingle();
  if (!refund) return { ok: false, httpStatus: 404, message: 'Refund not found.' };
  if (refund.status !== 'PENDING' || refund.refund_tx_hash) {
    return { ok: false, httpStatus: 409, message: 'Only an unpaid refund still pending can be retried instead.' };
  }

  // 1. Proven payment, checked on chain again now.
  const tx = await orderForRefund(refund);
  const deliverable = await deliverableOrder(tx);
  if (!tx || !deliverable.ok) return { ok: false, httpStatus: 409, message: deliverable.reason };

  // 2. The old request must not have been delivered (or be about to be).
  const old = await oldRequestState(tx.request_id);
  if (old === 'delivered') return { ok: false, httpStatus: 409, message: 'VTpass says the original request WAS delivered — use Requery in the Ledger instead of retrying.' };
  if (old === 'pending') return { ok: false, httpStatus: 409, message: 'VTpass is still processing the original request — wait, then Requery it.' };
  if (old === 'unknown') return { ok: false, httpStatus: 503, message: 'VTpass could not confirm the original request failed. Check the VTpass keys and try again.' };

  // 3. Hold the refund row.
  const { data: held } = await supabase.from('refund_queue')
    .update({ status: 'RETRYING', notes: `Delivery retried by ${admin}`, approved_by: admin, approved_at: new Date().toISOString() })
    .eq('id', refund.id).eq('status', 'PENDING').select('id');
  if (!held?.length) return { ok: false, httpStatus: 409, message: 'This refund is already being handled.' };

  // 4. Claim the order for one new delivery. The state guard (migration 026) forbids
  // FAILED_VENDING → PROCESSING and a new request_id on any plain update; this function is the one
  // audited exception (migration 046), service_role only.
  const vtRequestId = getStrictRequestId();
  const { data: claimed, error: claimError } = await supabase.rpc('claim_failed_vend_for_retry', { p_id: tx.id, p_request_id: vtRequestId });
  const locked = Array.isArray(claimed) ? claimed[0] : claimed;
  if (claimError || !locked) {
    await supabase.from('refund_queue').update({ status: 'PENDING' }).eq('id', refund.id).eq('status', 'RETRYING');
    return {
      ok: false, httpStatus: claimError ? 500 : 409,
      message: claimError ? `Could not claim the order for a retry: ${claimError.message}` : 'The order changed while retrying — reload and check it.',
    };
  }

  const { data: settings } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
  const baseRate = parseFloat(settings?.exchange_rate || '1500');
  const result = await executeVend(vendInputFromRow(locked, {
    txHash: locked.tx_hash, explorerUrl: explorerTxUrl(locked.blockchain, locked.tx_hash), baseRate, vtRequestId,
  }));

  if (result.status === 'SUCCESS') {
    await supabase.from('refund_queue')
      .update({ status: 'REJECTED', notes: `Delivered on retry by ${admin} (request ${vtRequestId}) — no refund owed.` })
      .eq('id', refund.id);
    return { ok: true, status: 'SUCCESS', message: 'Delivered. The order and the customer’s history now show it as successful.' };
  }
  if (result.status === 'FAILED_VENDING') {
    // enqueueRefund (inside executeVend) reopens the row; make sure it is, whatever happened there.
    await supabase.from('refund_queue').update({ status: 'PENDING' }).eq('id', refund.id).eq('status', 'RETRYING');
    return { ok: true, status: 'FAILED_VENDING', message: `VTpass refused it again: ${result.message || 'failed'}. It is back on the refund list.` };
  }
  return { ok: true, status: 'TIMEOUT', message: 'Sent to VTpass and still processing. The background sweep finishes it; check the Ledger shortly.' };
}
