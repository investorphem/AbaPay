import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { enqueueRefund } from '@/lib/refunds';
import type { VendInput, VendResult } from '@/lib/vend';

// 🏦 BANK TRANSFERS FOR VERIFIED AGENTS.
//
// Orders carry service_id MANUAL_BANK_SERVICE_ID. Every delivery path reaches executeVend
// (src/lib/vend.ts), which hands them here: one bank_payouts row per order (unique, so a second
// caller can't queue it twice) and the order moves PROCESSING -> AWAITING_PAYOUT. Admin → Agent →
// Bank payouts then records the transfer (markBankPayoutPaid -> SUCCESS) or refunds it
// (refundBankPayout -> FAILED_VENDING and the refund queue).
//
// AWAITING_PAYOUT is outside every sweep: reconcileStuck reads PENDING and PROCESSING only and
// sends these back here, and the fulfilment worker treats them as handed off (src/lib/jobs.ts).

export const MANUAL_BANK_SERVICE_ID = 'abapay-bank-payout';
export const AWAITING_PAYOUT = 'AWAITING_PAYOUT';
export const MAX_PROOF_BYTES = 2 * 1024 * 1024;
export const PROOF_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;

export function isManualBankOrder(serviceID: string | null | undefined): boolean {
  return serviceID === MANUAL_BANK_SERVICE_ID;
}

type TxRow = {
  id: string; tx_hash: string; status: string; wallet_address: string | null; amount_naira: number | null;
  account_number: string | null; variation_code: string | null; network: string | null; customer_name: string | null;
  self_agent_id: string | null; self_agent_address: string | null; amount_usdt: number | null; token_used: string | null;
  blockchain: string | null; source_channel: string | null; api_response: string | null;
};

/** executeVend's branch for a manual bank order. Never calls a provider. Never throws. */
export async function queueBankPayout(input: VendInput): Promise<VendResult> {
  try {
    const { data: row, error } = await supabase.from('transactions').select('*').eq('tx_hash', input.txHash).maybeSingle();
    if (error || !row) {
      await sendTelegramAlert(`🚨 *BANK PAYOUT ORDER NOT FOUND*\n\`${input.txHash}\` was paid as a verified-agent bank transfer but its order row couldn't be read${error ? ` (${error.message})` : ''}. Nothing was sent. Check the ledger.`).catch(() => {});
      return { success: true, status: 'TIMEOUT', message: 'Paid. The bank transfer is being prepared — check its status shortly; do not pay again.' };
    }
    const tx = row as TxRow;
    // Only an order proven paid and claimed (PROCESSING) is paid out; AWAITING_PAYOUT is already in hand.
    // Every delivery path claims PENDING -> PROCESSING only after the payment is proven on chain.
    if (tx.status === AWAITING_PAYOUT) return { success: true, status: 'AWAITING_PAYOUT', message: 'Paid. The bank transfer is already queued; do not pay again.' };
    if (tx.status !== 'PROCESSING') return { success: true, status: 'TIMEOUT', message: 'This payment is not confirmed yet; the bank transfer is queued once it is. Do not pay again.' };
    if (!tx.self_agent_id || !tx.self_agent_address) {
      // Only a verified agent's order can carry this service id; one without the Self record is
      // not something to pay out on. Flag it and hand it to the refund queue.
      await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'BANK_PAYOUT_UNVERIFIED', api_response: 'Bank transfer order has no verified Self Agent ID.' }).eq('id', tx.id).eq('status', 'PROCESSING');
      await refundOrder(tx, 'Bank transfer order without a verified Self Agent ID.');
      return { success: false, status: 'FAILED_VENDING', message: 'This bank transfer could not be sent. A refund is on its way.' };
    }

    const { error: insertError } = await supabase.from('bank_payouts').insert({
      transaction_id: tx.id, tx_hash: tx.tx_hash, wallet: String(tx.wallet_address || '').toLowerCase(),
      self_agent_id: tx.self_agent_id, self_agent_address: tx.self_agent_address,
      bank_code: String(tx.variation_code || ''), bank_name: tx.network || null,
      account_number: String(tx.account_number || ''), account_name: tx.customer_name || null,
      amount_ngn: Number(tx.amount_naira), status: 'AWAITING',
    });
    // 23505: already queued by another delivery path — it's in hand, say so and stop.
    if (insertError && insertError.code !== '23505') throw new Error(insertError.message);
    const fresh = !insertError;

    await supabase.from('transactions').update({ status: AWAITING_PAYOUT, api_response: 'Paid. Bank transfer queued.' })
      .eq('id', tx.id).eq('status', 'PROCESSING');

    if (fresh) {
      await sendTelegramAlert(
        `🏦 *BANK PAYOUT TO SEND* (verified agent)\n` +
        `💰 *Amount:* ₦${Number(tx.amount_naira).toLocaleString()}\n` +
        `🏛 *Bank:* ${tx.network || '?'} (code \`${tx.variation_code || '?'}\`)\n` +
        `🔢 *Account:* \`${tx.account_number}\`\n` +
        `👤 *Name:* ${tx.customer_name || 'not verified'}\n` +
        `🪪 *Self Agent ID:* #${tx.self_agent_id}\n` +
        `👛 *Payer:* \`${tx.wallet_address}\`\n` +
        `🔗 \`${tx.tx_hash}\`\n\n` +
        `Send it, then record the reference and receipt in Admin → Agent → Bank payouts.`,
      ).catch(() => {});
    }
    return { success: true, status: 'AWAITING_PAYOUT', message: 'Paid. The bank transfer has been queued; its reference and receipt appear in the payment status once it is sent. Do not pay again.' };
  } catch (err) {
    console.error('[BankPayout] queue failed:', err);
    await sendTelegramAlert(`🚨 *BANK PAYOUT QUEUE FAILED*\n\`${input.txHash}\`: ${err instanceof Error ? err.message : String(err)}\nThe order is paid. Queue it by hand.`).catch(() => {});
    return { success: true, status: 'TIMEOUT', message: 'Paid. The bank transfer is being prepared — check its status shortly; do not pay again.' };
  }
}

async function refundOrder(tx: TxRow, reason: string) {
  return enqueueRefund({
    txHash: tx.tx_hash, walletAddress: String(tx.wallet_address || ''), tokenUsed: String(tx.token_used || 'USDC'),
    amountCrypto: Number(tx.amount_usdt || 0), amountNaira: Number(tx.amount_naira || 0), blockchain: tx.blockchain || 'CELO',
    reason, serviceCategory: 'BANK', sourceChannel: tx.source_channel || 'AGENT', transactionId: tx.id,
  });
}

export type PayoutRow = {
  id: string; transaction_id: string; tx_hash: string; wallet: string; self_agent_id: string; self_agent_address: string;
  bank_code: string; bank_name: string | null; account_number: string; account_name: string | null; amount_ngn: number;
  status: 'AWAITING' | 'PAID' | 'REFUNDED'; payout_reference: string | null; proof_mime: string | null;
  operator_note: string | null; paid_at: string | null; paid_by: string | null; created_at: string;
};

export const PAYOUT_LIST_COLUMNS = 'id, transaction_id, tx_hash, wallet, self_agent_id, self_agent_address, bank_code, bank_name, account_number, account_name, amount_ngn, status, payout_reference, proof_mime, operator_note, paid_at, paid_by, created_at';

/** Decode a data: URL or bare base64 receipt. Null when it's not an accepted type or too big. */
export function decodeProof(dataUrlOrBase64: string, mime?: string): { bytes: Buffer; mime: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrlOrBase64);
  const type = (m ? m[1] : mime || '').toLowerCase();
  if (!(PROOF_MIMES as readonly string[]).includes(type)) return null;
  const bytes = Buffer.from(m ? m[2] : dataUrlOrBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PROOF_BYTES) return null;
  return { bytes, mime: type };
}

/** Postgres bytea literal for supabase-js (hex form). */
export const toBytea = (b: Buffer) => `\\x${b.toString('hex')}`;
/** And back: supabase-js returns bytea as a hex string. */
export function fromBytea(v: unknown): Buffer | null {
  if (typeof v !== 'string' || !v.startsWith('\\x')) return null;
  return Buffer.from(v.slice(2), 'hex');
}

export async function markBankPayoutPaid(p: { payoutId: string; reference: string; proof: { bytes: Buffer; mime: string } | null; note?: string | null; admin: string }) {
  const reference = p.reference.trim().slice(0, 120);
  if (!reference) return { ok: false as const, error: 'The transfer reference is required.' };
  const { data: payout } = await supabase.from('bank_payouts').select(PAYOUT_LIST_COLUMNS).eq('id', p.payoutId).maybeSingle();
  const po = payout as PayoutRow | null;
  if (!po) return { ok: false as const, error: 'Payout not found.' };
  if (po.status !== 'AWAITING') return { ok: false as const, error: `This payout is already ${po.status}.` };

  const { data: updated, error } = await supabase.from('bank_payouts').update({
    status: 'PAID', payout_reference: reference, paid_at: new Date().toISOString(), paid_by: p.admin.toLowerCase(),
    operator_note: p.note ? String(p.note).slice(0, 500) : null,
    ...(p.proof ? { proof_image: toBytea(p.proof.bytes), proof_mime: p.proof.mime } : {}),
  }).eq('id', po.id).eq('status', 'AWAITING').select('id');
  if (error) return { ok: false as const, error: error.message };
  if (!updated?.length) return { ok: false as const, error: 'This payout was changed by someone else; reload.' };

  await supabase.from('transactions').update({
    status: 'SUCCESS', purchased_code: `Bank transfer reference: ${reference}`, api_response: `Bank transfer sent. Reference ${reference}.`,
  }).eq('id', po.transaction_id).eq('status', AWAITING_PAYOUT);
  return { ok: true as const };
}

export async function refundBankPayout(p: { payoutId: string; reason: string; admin: string }) {
  const { data: payout } = await supabase.from('bank_payouts').select(PAYOUT_LIST_COLUMNS).eq('id', p.payoutId).maybeSingle();
  const po = payout as PayoutRow | null;
  if (!po) return { ok: false as const, error: 'Payout not found.' };
  if (po.status !== 'AWAITING') return { ok: false as const, error: `This payout is already ${po.status}.` };
  const reason = (p.reason || 'The bank transfer could not be sent.').trim().slice(0, 300);

  const { data: updated } = await supabase.from('bank_payouts').update({ status: 'REFUNDED', operator_note: reason, paid_by: p.admin.toLowerCase() })
    .eq('id', po.id).eq('status', 'AWAITING').select('id');
  if (!updated?.length) return { ok: false as const, error: 'This payout was changed by someone else; reload.' };

  const { data: tx } = await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'BANK_PAYOUT_NOT_SENT', api_response: reason })
    .eq('id', po.transaction_id).eq('status', AWAITING_PAYOUT).select('*').maybeSingle();
  if (tx) await refundOrder(tx as TxRow, reason);
  return { ok: true as const };
}
