import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { notifyUserRefundCompleted } from '@/lib/refunds';
import { getPublicClient, resolveChain, explorerBaseFor } from '@/lib/chain';
import { resolveTokenOnChain } from '@/constants';
import { parseUnits, decodeEventLog } from 'viem';

// ⚡ REFUND VERIFICATION — ONE IMPLEMENTATION, THREE CALLERS
//
// 🔴 THE BUG THIS FIXES: a refund that went out ON-CHAIN was left showing as still owed.
//
// Both admin refund endpoints used to call `getTransactionReceipt` the instant the operator's
// browser handed them a hash. That call is not "is this transaction good?" — it is "is this
// transaction ALREADY MINED?", and it throws (TransactionReceiptNotFoundError) for a hash that
// was broadcast a second ago and is still in the mempool. The Ops tab's flow makes that the
// NORMAL case, not an edge one: executeRefundOnChain returns as soon as writeContract
// broadcasts, without waiting for a receipt, so the POST that follows almost always arrives
// before the transaction is mined. Every such refund got "Could not read that refund
// transaction from the blockchain", the hash was DISCARDED, and refund_queue stayed PENDING
// forever while the money had genuinely left the vault. The same happened on any transient RPC
// hiccup. That is how a refund ends up paid on-chain and unpaid in the admin.
//
// Two changes close it, and both live here so the two endpoints and the sweep can't drift:
//   1. WAIT for the receipt (bounded) instead of demanding it already exist.
//   2. When it still isn't confirmable, that is NOT a failure — the hash is REMEMBERED on the
//      row (status stays PENDING, refund_tx_hash set) so reconcileRecordedRefunds below can
//      finish the job on the next sweep. Nothing is ever recorded as refunded without the
//      on-chain proof; it just stops being FORGOTTEN while it waits for one.

const ERC20_TRANSFER_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
  name: 'Transfer',
  type: 'event',
}] as const;

export type RefundVerdict =
  /** Confirmed on-chain: the right token reached the right wallet for at least the right amount. */
  | { status: 'VERIFIED' }
  /** Broadcast but not yet mined/readable. The hash is worth keeping — retry later. */
  | { status: 'UNCONFIRMED'; detail: string }
  /** Mined and failed. Nothing moved; safe to send again. */
  | { status: 'REVERTED' }
  /** Mined and succeeded, but it does not pay this refund (wrong token/recipient/amount). */
  | { status: 'MISMATCH' };

export interface RefundClaim {
  blockchain: string | null | undefined;
  tokenUsed: string | null | undefined;
  walletAddress: string | null | undefined;
  amountCrypto: number | string | null | undefined;
  refundTxHash: string;
}

/**
 * Prove (or disprove) that `refundTxHash` actually paid this refund.
 *
 * `waitMs > 0` waits for the transaction to be mined rather than requiring that it already is
 * — which is what an operator's just-broadcast hash needs. 0 makes it a pure read, for the
 * background sweep where nothing is waiting on the answer.
 */
export async function verifyRefundOnChain(claim: RefundClaim, waitMs = 0): Promise<RefundVerdict> {
  let receipt: any;
  try {
    const client = getPublicClient(claim.blockchain);
    receipt = waitMs > 0
      ? await client.waitForTransactionReceipt({ hash: claim.refundTxHash as `0x${string}`, timeout: waitMs })
      : await client.getTransactionReceipt({ hash: claim.refundTxHash as `0x${string}` });
  } catch (err: any) {
    // Not mined yet, or the RPC is unhappy. Either way this is "ask again later", NOT "this
    // refund is bad" — the caller keeps the hash instead of throwing it away.
    return { status: 'UNCONFIRMED', detail: err?.shortMessage || err?.message || 'receipt unavailable' };
  }

  if (receipt.status !== 'success') return { status: 'REVERTED' };

  const { isMainnet } = resolveChain(claim.blockchain);
  const token = resolveTokenOnChain(claim.tokenUsed || 'USD₮', claim.blockchain || 'CELO', isMainnet);
  const recipient = String(claim.walletAddress || '').toLowerCase();
  if (!token || !recipient) return { status: 'MISMATCH' };

  const requiredWei = parseUnits(Number(claim.amountCrypto).toFixed(token.decimals), token.decimals);
  const tolerance = parseUnits('0.01', token.decimals); // 1-cent rounding grace

  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== token.address) continue;
    try {
      const decoded: any = decodeEventLog({ abi: ERC20_TRANSFER_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') continue;
      if (String(decoded.args.to).toLowerCase() !== recipient) continue;
      const paid = BigInt(decoded.args.value);
      const shortfall = requiredWei > paid ? requiredWei - paid : BigInt(0);
      if (shortfall <= tolerance) return { status: 'VERIFIED' };
    } catch { /* not a Transfer log */ }
  }

  return { status: 'MISMATCH' };
}

/**
 * Has this hash already been banked against a DIFFERENT refund?
 *
 * 🔴 WHY VERIFICATION ALONE ISN'T ENOUGH. A failed vend that the user retries produces TWO queue
 * rows with the same wallet, the same token and the same amount, minutes apart — that pattern is
 * all over the live queue. On-chain verification cannot tell those apart: one payout satisfies
 * the checks for BOTH rows, so pasting the same hash twice would mark two debts settled with one
 * payment and leave the second user (or the same user's second attempt) quietly unpaid.
 *
 * Keyed on the hash rather than on amounts, so it is exact rather than a heuristic.
 */
export async function refundHashAlreadyUsed(refundTxHash: string, exceptId?: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('refund_queue')
    .select('id')
    .eq('refund_tx_hash', refundTxHash)
    .eq('status', 'COMPLETED')
    .limit(2);
  return (data || []).some((row: any) => row.id !== exceptId);
}

/**
 * Mark a verified refund complete everywhere it needs to be: the queue row, the transaction
 * ledger, and the user. Shared so the two endpoints and the sweep write the SAME thing.
 *
 * Idempotent — the queue update is guarded on the row still being PENDING, so a sweep racing
 * an operator's click cannot notify the user twice.
 */
export async function completeRefund(refund: any, refundTxHash: string, opts: { approvedBy?: string; notes?: string | null } = {}) {
  const { data: claimed } = await supabaseAdmin
    .from('refund_queue')
    .update({
      status: 'COMPLETED',
      refund_tx_hash: refundTxHash,
      approved_by: opts.approvedBy || refund.approved_by || 'admin',
      approved_at: refund.approved_at || new Date().toISOString(),
      completed_at: new Date().toISOString(),
      notes: opts.notes ?? refund.notes ?? null,
    })
    .eq('id', refund.id)
    .eq('status', 'PENDING')
    .select();

  // Someone else finished it first — don't notify again.
  if (!claimed || claimed.length === 0) return false;

  if (refund.tx_hash) {
    await supabaseAdmin.from('transactions')
      .update({ status: 'REFUNDED', refund_hash: refundTxHash })
      .eq('tx_hash', refund.tx_hash);
  }

  try { await notifyUserRefundCompleted(refund, refundTxHash); } catch { /* best-effort */ }
  return true;
}

/**
 * Remember a hash we could not confirm YET, without recording the refund as done.
 *
 * This is the whole point of the fix: the operator's transaction is already on the network,
 * so the one thing that must not happen is losing the only pointer to it.
 */
export async function rememberRefundHash(refundId: string, refundTxHash: string, approvedBy?: string) {
  await supabaseAdmin
    .from('refund_queue')
    .update({
      refund_tx_hash: refundTxHash,
      approved_by: approvedBy || 'admin',
      approved_at: new Date().toISOString(),
      notes: 'Broadcast on-chain; awaiting confirmation. Will complete automatically once mined.',
    })
    .eq('id', refundId)
    .eq('status', 'PENDING');
}

const MIN_INTERVAL_MS = 2 * 60 * 1000;
let lastRun = 0;

/**
 * ⚡ THE SAFETY NET: finish refunds that were broadcast but never recorded.
 *
 * Picks up every PENDING queue row that already carries a refund_tx_hash — put there either by
 * rememberRefundHash above, or by an operator pasting a hash — and asks the chain what happened
 * to it. Confirmed refunds are completed (and the user told); reverted ones have the dead hash
 * cleared so the row is cleanly refundable again; a mismatch is escalated rather than guessed at.
 *
 * Runs from /api/cleanup alongside the other sweeps.
 */
export async function reconcileRecordedRefunds(opts: { force?: boolean } = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRun < MIN_INTERVAL_MS) {
    return { ok: true, skipped: true, completed: 0, cleared: 0, stillPending: 0 };
  }
  lastRun = now;

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('refund_queue')
      .select('*')
      .eq('status', 'PENDING')
      .not('refund_tx_hash', 'is', null)
      .limit(50);

    if (error) return { ok: false, error: error.message, completed: 0, cleared: 0, stillPending: 0 };
    if (!rows?.length) return { ok: true, completed: 0, cleared: 0, stillPending: 0 };

    let completed = 0, cleared = 0, stillPending = 0;

    for (const row of rows) {
      // The same payout cannot clear two debts — see refundHashAlreadyUsed. Escalate rather
      // than complete, since which row the hash belongs to is a human judgement.
      if (await refundHashAlreadyUsed(row.refund_tx_hash, row.id)) {
        sendTelegramAlert(
          `⚠️ *REFUND HASH USED TWICE*\n\nA pending refund carries a hash already recorded against a completed refund.\n\n` +
          `💰 ${row.amount_crypto} ${row.token_used} → \`${row.wallet_address}\`\n🔗 \`${row.refund_tx_hash}\`\n\n` +
          `Not completed automatically — one payout cannot settle two refunds.`,
        ).catch(() => {});
        stillPending++;
        continue;
      }

      const verdict = await verifyRefundOnChain({
        blockchain: row.blockchain,
        tokenUsed: row.token_used,
        walletAddress: row.wallet_address,
        amountCrypto: row.amount_crypto,
        refundTxHash: row.refund_tx_hash,
      });

      if (verdict.status === 'VERIFIED') {
        const done = await completeRefund(row, row.refund_tx_hash, {
          notes: 'Confirmed on-chain by the reconciliation sweep.',
        });
        if (done) {
          completed++;
          const explorer = `${explorerBaseFor(row.blockchain)}/tx/${row.refund_tx_hash}`;
          sendTelegramAlert(
            `✅ *REFUND RECONCILED*\n\nA refund that was sent on-chain but never recorded has been completed automatically.\n\n` +
            `💰 ${row.amount_crypto} ${row.token_used} → \`${row.wallet_address}\`\n🔗 ${explorer}`,
          ).catch(() => {});
        }
        continue;
      }

      if (verdict.status === 'REVERTED') {
        // The transaction failed, so no money left the vault. Clear the dead hash so the row
        // reads as plainly refundable again instead of looking half-done forever.
        await supabaseAdmin.from('refund_queue').update({
          refund_tx_hash: null,
          notes: 'Previous refund attempt reverted on-chain — no funds moved. Safe to refund again.',
        }).eq('id', row.id).eq('status', 'PENDING');
        cleared++;
        continue;
      }

      if (verdict.status === 'MISMATCH') {
        // Mined, succeeded, and pays something OTHER than this refund. Never auto-complete
        // that, and never silently discard it either — a human has to look.
        sendTelegramAlert(
          `⚠️ *REFUND HASH DOESN'T MATCH*\n\nA hash recorded against a pending refund confirmed on-chain but does not pay it ` +
          `(token, recipient or amount differs).\n\n💰 expected ${row.amount_crypto} ${row.token_used} → \`${row.wallet_address}\`\n` +
          `🔗 \`${row.refund_tx_hash}\`\n\nCheck it in the Ops tab before refunding again.`,
        ).catch(() => {});
        stillPending++;
        continue;
      }

      stillPending++; // still unconfirmed — try again next sweep
    }

    return { ok: true, completed, cleared, stillPending };
  } catch (err: any) {
    console.error('[RefundReconcile] sweep failed:', err?.message);
    return { ok: false, error: err?.message, completed: 0, cleared: 0, stillPending: 0 };
  }
}
