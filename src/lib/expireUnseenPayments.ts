import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { getPublicClient } from '@/lib/chain';
import { sendTelegramAlert } from '@/lib/telegram';
import { errorMessage } from '@/lib/errors';

// 🧹 CLOSE CELO/BASE ORDERS WHOSE PAYMENT HASH NEVER APPEARED ON CHAIN.
//
// 2026-11-16: a prober told /api/pay it had paid with a made-up hash (0xdede…, Base). The order sat
// PENDING with that hash for good — reconcileStuckProcessing only asks VTpass, never the chain — and
// looked refundable. This sweep asks the chain itself: an order still PENDING long after any real
// transaction would have been mined, whose hash has no receipt AND is not even waiting in the
// mempool, never paid. It is closed as EXPIRED, which the state guard makes terminal.
//
// Deliberately narrow:
//   • Celo / Base only. NIM orders get their hash only after the Nimiq chain has proven the payment.
//   • PENDING only. PROCESSING means the payment was already verified and the vend lock taken.
//   • Only a definite "not on chain": any RPC error leaves the row alone for the next run.
//   • 6 hours: Celo and Base produce a block every few seconds; nothing real waits that long.

export const UNSEEN_AFTER_MS = 6 * 60 * 60 * 1000;
const BATCH = 25;
const EVM_HASH = /^0x[0-9a-f]{64}$/i;

type Row = { id: string; tx_hash: string; blockchain: string; amount_usdt: number | string | null; token_used: string | null; wallet_address: string | null };

const isNotFound = (e: unknown) => /NotFound|could not be found|not found/i.test(`${(e as { name?: string })?.name || ''} ${errorMessage(e)}`);

/** 'unseen' only when the chain definitely has no such transaction, mined or pending. */
async function chainHasTx(blockchain: string, hash: `0x${string}`): Promise<'seen' | 'unseen' | 'unknown'> {
  const client = getPublicClient(blockchain);
  try {
    await client.getTransactionReceipt({ hash });
    return 'seen';
  } catch (e) {
    if (!isNotFound(e)) return 'unknown';
  }
  try {
    await client.getTransaction({ hash });
    return 'seen'; // still waiting in the mempool
  } catch (e) {
    return isNotFound(e) ? 'unseen' : 'unknown';
  }
}

export async function expireUnseenPayments(opts: { now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const { data, error } = await supabase
    .from('transactions')
    .select('id, tx_hash, blockchain, amount_usdt, token_used, wallet_address')
    .eq('status', 'PENDING')
    .in('blockchain', ['CELO', 'BASE'])
    .like('tx_hash', '0x%')
    .lt('created_at', new Date(now - UNSEEN_AFTER_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH);
  if (error) return { ok: false, error: error.message, expired: 0, checked: 0 };

  const closed: Row[] = [];
  const misfiled: (Row & { other: string })[] = [];
  let checked = 0;
  for (const row of (data || []) as Row[]) {
    if (!EVM_HASH.test(row.tx_hash)) continue;
    checked++;
    const hash = row.tx_hash.toLowerCase() as `0x${string}`;
    const seen = await chainHasTx(row.blockchain, hash).catch(() => 'unknown' as const);
    if (seen !== 'unseen') continue;
    // The OTHER EVM chain too: an order saved under the wrong chain is not a fake. 2026-11-16 the
    // first run closed a Base order whose hash was a real Celo transaction (a refund to the payer).
    // Found there, or unreadable there → leave it for a person to look at.
    const other = String(row.blockchain).toUpperCase() === 'BASE' ? 'CELO' : 'BASE';
    const elsewhere = await chainHasTx(other, hash).catch(() => 'unknown' as const);
    if (elsewhere !== 'unseen') {
      if (elsewhere === 'seen') misfiled.push({ ...row, other });
      continue;
    }
    const { data: updated } = await supabase.from('transactions').update({
      status: 'EXPIRED',
      error_code: 'TX_NOT_ON_CHAIN',
      api_response: `The payment hash ${row.tx_hash} was never found on ${row.blockchain} (no receipt, not pending) ${Math.round(UNSEEN_AFTER_MS / 3600000)}h after the order. Nothing was paid; nothing is owed.`,
    }).eq('id', row.id).eq('status', 'PENDING').select('id');
    if (updated && updated.length) closed.push(row);
  }

  if (closed.length) {
    await sendTelegramAlert(
      `🧹 *CLOSED ${closed.length} ORDER(S) WITH NO PAYMENT ON-CHAIN*\nTheir payment hash never appeared on the chain, so nothing was paid or owed:\n` +
      closed.map((r) => `• ${r.blockchain} \`${r.tx_hash.slice(0, 12)}…\` · ${r.amount_usdt} ${r.token_used || ''} · \`${r.wallet_address || 'unknown'}\``).join('\n'),
    ).catch(() => {});
  }
  if (misfiled.length) {
    await sendTelegramAlert(
      `🔎 *ORDER(S) SAVED UNDER THE WRONG CHAIN — LEFT OPEN*\nThe payment hash isn't on the order's chain but IS on the other one. Check by hand (it may be a payment or a refund):\n` +
      misfiled.map((r) => `• ${r.blockchain} order, hash found on ${r.other}: \`${r.tx_hash}\` · ${r.amount_usdt} ${r.token_used || ''}`).join('\n'),
    ).catch(() => {});
  }
  return { ok: true, checked, expired: closed.length, misfiled: misfiled.length };
}
