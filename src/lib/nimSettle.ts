import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { executeVend, getStrictRequestId, type VendResult } from '@/lib/vend';
import { vendInputFromRow } from '@/lib/vendInput';
import { metric } from '@/lib/log';
import { NIM_TX_HASH_RE, UNDECIDED_NIM_FAILURES, LUNA_PER_NIM, recentTreasuryPayments, paymentReference, verifyNimPayment } from '@/lib/nimiq';

// ⚡ SETTLING A NIM PAYMENT — shared by /api/pay/nim (the mini app reports its transaction hash)
// and the cleanup sweep (the app closed before reporting it). Same shape as /api/pay's settle:
//
//   1. the intent row is the only source of what was owed (luna, payer, reference);
//   2. the transaction is read from the Nimiq chain and checked against it (src/lib/nimiq.ts);
//   3. one conditional write attaches the hash, takes PENDING -> PROCESSING and issues the
//      vend's request_id. transactions.tx_hash is UNIQUE, so one payment backs one row;
//   4. the vend runs from the row (src/lib/vend.ts), which queues a refund if delivery fails.
//
// An undecided proof (RPC down, not on chain yet, not deep enough) leaves the row PENDING and
// attaches nothing: a hash that isn't proven yet must not squat on a row.

export const NIM_INTENT_PREFIX = 'preflight_nim_';
export const NIM_EXPLORER = 'https://nimiq.watch/#';

export type NimSettleOutcome = VendResult & { code?: string; verifying?: boolean };

const alert = (text: string) => sendTelegramAlert(text).catch(() => {});

type IntentRow = Record<string, unknown> & {
  id: string; tx_hash: string; status: string; wallet_address: string; amount_usdt: number | string;
  network?: string; service_category?: string;
};

/** Luna the row requires. amount_usdt holds the NIM charged on NIM rows (token_used = 'NIM'). */
const lunaOwed = (row: IntentRow) => Math.round(Number(row.amount_usdt) * LUNA_PER_NIM);

export async function settleNimIntent(row: IntentRow, rawHash: string): Promise<NimSettleOutcome> {
  const txHash = String(rawHash || '').toLowerCase();
  if (!NIM_TX_HASH_RE.test(txHash)) {
    return { success: false, status: 'FAILED_VENDING', code: 'BAD_HASH', message: 'A Nimiq transaction hash is required.' };
  }
  if (!row.tx_hash.startsWith(NIM_INTENT_PREFIX)) {
    // Already settled (or not a NIM intent): answer from the row, never vend twice.
    return row.status === 'SUCCESS'
      ? { success: true, status: 'SUCCESS' }
      : { success: row.status === 'PROCESSING', status: row.status === 'PROCESSING' ? 'TIMEOUT' : 'FAILED_VENDING', message: 'This order has already been handled.' };
  }
  if (row.status !== 'PENDING') {
    if (row.status === 'EXPIRED') {
      await alert(`🚨 *NIM PAID AFTER INTENT EXPIRED*\nIntent \`${row.tx_hash}\` expired, then reported paid with \`${txHash}\`. Needs a manual vend or NIM refund.\n👤 Payer: \`${row.wallet_address}\`\n💰 ${row.amount_usdt} NIM\n🔍 ${NIM_EXPLORER}${txHash}`);
      return { success: false, status: 'TIMEOUT', code: 'INTENT_EXPIRED', message: 'This payment is being reviewed. Contact support if it isn’t resolved shortly.' };
    }
    return { success: false, status: 'FAILED_VENDING', message: 'This order can no longer be paid.' };
  }

  const proof = await verifyNimPayment(txHash, { minLuna: lunaOwed(row), intentId: row.tx_hash, payer: row.wallet_address });
  if (!proof.ok && UNDECIDED_NIM_FAILURES.has(proof.code)) {
    return { success: false, status: 'TIMEOUT', verifying: true, code: proof.code, message: 'Waiting for the Nimiq network to confirm your payment.' };
  }
  if (!proof.ok) {
    metric('nim_payment_rejected_total', 1, { code: proof.code });
    // A NIM payment that moved but doesn't match (short, wrong reference or sender) is real money
    // in the treasury: the operator has to look at it, so it's alerted, not just refused.
    await alert(`🚨 *NIM PAYMENT REJECTED — ${proof.code}*\n${proof.detail}\nIntent: \`${row.tx_hash}\`\n👤 Payer: \`${row.wallet_address}\`\n🔍 ${NIM_EXPLORER}${txHash}`);
    if (proof.code !== 'TREASURY_NOT_CONFIGURED') {
      await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: proof.code, api_response: `${proof.detail} (tx ${txHash})`.slice(0, 500) })
        .eq('id', row.id).eq('status', 'PENDING');
    }
    return { success: false, status: 'FAILED_VENDING', code: proof.code, message: proof.code === 'TREASURY_NOT_CONFIGURED' ? 'NIM payments are temporarily unavailable.' : 'This payment didn’t match the order it was made for.' };
  }

  const vtRequestId = getStrictRequestId();
  const { data: locked, error: lockError } = await supabase.from('transactions')
    .update({ tx_hash: txHash, status: 'PROCESSING', request_id: vtRequestId })
    .eq('id', row.id).eq('status', 'PENDING')
    .select().maybeSingle();
  if (lockError?.code === '23505') {
    await alert(`🚨 *NIM PAYMENT REPLAY BLOCKED*\nHash \`${txHash}\` is already attached to another order.\n👤 Payer: \`${row.wallet_address}\``);
    return { success: false, status: 'FAILED_VENDING', code: 'PAYMENT_ALREADY_USED', message: 'That payment has already been used.' };
  }
  if (!locked || lockError) {
    // Someone else (the sweep, or a second tap) took the lock first: they vend.
    return { success: true, status: 'TIMEOUT', message: 'Your order is being processed.' };
  }

  const { data: settings } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
  const baseRate = parseFloat(settings?.exchange_rate || '1500');
  metric('nim_payments_settled_total', 1, { service: String(row.service_category || '') });
  return executeVend(vendInputFromRow(locked, { txHash, explorerUrl: `${NIM_EXPLORER}${txHash}`, baseRate, vtRequestId }));
}

// ── Sweep ────────────────────────────────────────────────────────────────────────────────────

/** Minutes a NIM intent may stay unpaid before the sweep expires it. */
const NIM_INTENT_TTL_MINUTES = 60;
let lastRun = 0;

/**
 * Settles NIM intents whose payment reached the treasury but whose settle call never came, and
 * expires the ones still unpaid after an hour. Run from /api/cleanup.
 */
export async function reconcileNimIntents(opts: { force?: boolean } = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRun < 2 * 60_000) return { ok: true, skipped: true, settled: 0, expired: 0 };
  lastRun = now;

  const { data: rows, error } = await supabase.from('transactions').select('*')
    .eq('status', 'PENDING').like('tx_hash', `${NIM_INTENT_PREFIX}%`)
    .lt('created_at', new Date(now - 2 * 60_000).toISOString())
    .order('created_at', { ascending: true }).limit(100);
  if (error) return { ok: false, error: error.message, settled: 0, expired: 0 };
  if (!rows?.length) return { ok: true, settled: 0, expired: 0 };

  const payments = await recentTreasuryPayments();
  if (!payments) return { ok: false, error: 'Treasury history unreadable.', settled: 0, expired: 0 };

  let settled = 0;
  let expired = 0;
  for (const row of rows as IntentRow[]) {
    const tx = payments.get(paymentReference(row.tx_hash));
    if (tx) {
      const out = await settleNimIntent(row, tx.hash);
      if (out.status !== 'TIMEOUT' || !out.verifying) settled++;
      continue;
    }
    if (now - new Date(String(row.created_at)).getTime() > NIM_INTENT_TTL_MINUTES * 60_000) {
      const { error: e } = await supabase.from('transactions')
        .update({ status: 'EXPIRED', error_code: 'PREFLIGHT_UNCONFIRMED', api_response: 'No NIM payment reached the treasury for this order.' })
        .eq('id', row.id).eq('status', 'PENDING');
      if (!e) expired++;
    }
  }
  return { ok: true, settled, expired };
}
