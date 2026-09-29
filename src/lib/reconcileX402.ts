import 'server-only';
import { parseAbi, parseUnits } from 'viem';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { executeVend } from '@/lib/vend';
import { vendInputFromRow } from '@/lib/vendInput';
import { enqueueRefund } from '@/lib/refunds';
import { verifyAccount } from '@/lib/deai/services';
import { getPublicClient, isMainnetEnv, explorerBaseFor } from '@/lib/chain';
import { resolveTokenOnChain, normalizeChainName } from '@/constants';
import { verifyTokenTransfer, vaultAddressFor, UNDECIDED_PROOF_FAILURES } from '@/lib/paymentProof';

// ⚡ x402 INTENT RECONCILER — the safety net for the one gap the x402 route cannot close itself.
//
// /api/pay/x402 records a PENDING intent BEFORE the facilitator moves any money (see
// "RECORD THE PAYMENT BEFORE ANY MONEY MOVES" in that route). If the request then dies — the
// function is killed, the facilitator never answers, the chain can't be read — the intent is
// left PENDING with the signed authorization's (payer, nonce) on it. The token itself is the
// authority on what happened next, via `authorizationState(payer, nonce)`:
//
//   facilitator hash on the row  -> verify its Transfer log -> vend it (or flag it)
//   authorization SPENT, no hash -> money moved, hash unknown -> flag for manual reconciliation
//   authorization UNSPENT        -> after validBefore it can never be spent -> close as EXPIRED
//   unreadable                   -> leave it; alert once if it stays unreadable for 30 min
//
// Also watches recently REFUSED intents (FAILED_PAYMENT) for a settlement that landed after the
// facilitator said no — a late landing must never pass unnoticed.
//
// Runs from /api/cleanup (the scheduled sweep) and opportunistically from the Alchemy webhook,
// throttled like the other sweeps. Idempotent: every write is conditional on the row still
// being in the state this run read, so two overlapping runs can't double-vend.

const INTENT_PREFIX = 'preflight_x402_';
const MIN_AGE_MS = (Number(process.env.X402_INTENT_RECONCILE_MINUTES) || 2) * 60_000;
const UNREADABLE_ALERT_AFTER_MS = 30 * 60_000;
const LATE_SETTLEMENT_WINDOW_MS = 48 * 60 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;
const BATCH = 25;

let lastRun = 0;

/** The placeholder tx_hash of an x402 intent: one per (chain, payer, authorization nonce). */
export function x402IntentKey(chain: string, payer: string, nonce: string): string {
  return `${INTENT_PREFIX}${normalizeChainName(chain)}_${payer.toLowerCase()}_${nonce.toLowerCase()}`;
}

/**
 * The tx_hash for a settlement the chain proves happened but whose hash is unknown. Outside the
 * `preflight_` namespace on purpose, so History and Admin show it.
 */
export function x402UnconfirmedKey(chain: string, nonce: string): string {
  return `x402_unconfirmed_${normalizeChainName(chain)}_${nonce}`;
}

const AUTHORIZATION_STATE_ABI = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)']);

async function authorizationState(row: Row): Promise<boolean | null> {
  const token = resolveTokenOnChain(row.token_used, normalizeChainName(row.blockchain), isMainnetEnv());
  if (!token || !row.x402_payer || !row.x402_nonce) return null;
  try {
    return await getPublicClient(row.blockchain).readContract({
      address: token.address as `0x${string}`,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [row.x402_payer as `0x${string}`, row.x402_nonce as `0x${string}`],
    }) as boolean;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come from the untyped Supabase client
type Row = Record<string, any>;

async function alert(text: string) {
  try { await sendTelegramAlert(text); } catch { /* alerting never changes an outcome */ }
}

export interface X402ReconcileResult {
  ok: boolean;
  skipped?: boolean;
  vended: number;
  flagged: number;
  expired: number;
  pending: number;
  error?: string;
}

export async function reconcileX402Intents(opts: { force?: boolean; now?: number } = {}): Promise<X402ReconcileResult> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastRun < MIN_INTERVAL_MS) {
    return { ok: true, skipped: true, vended: 0, flagged: 0, expired: 0, pending: 0 };
  }
  lastRun = now;

  const result: X402ReconcileResult = { ok: true, vended: 0, flagged: 0, expired: 0, pending: 0 };

  const { data: open, error } = await supabase.from('transactions')
    .select('*')
    .eq('status', 'PENDING')
    .like('tx_hash', `${INTENT_PREFIX}%`)
    .lt('created_at', new Date(now - MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH);
  if (error) return { ...result, ok: false, error: error.message };

  for (const row of (open || []) as Row[]) {
    try {
      const outcome = row.x402_settle_tx ? await resolveWithHash(row) : await resolveWithoutHash(row, now);
      result[outcome]++;
    } catch (err) {
      console.error('[ReconcileX402] error on intent', row.tx_hash, (err as Error)?.message);
      result.pending++;
    }
  }

  await watchRefusedIntents(now);
  return result;
}

/** The facilitator named a transaction: prove it on-chain, then vend it exactly once. */
async function resolveWithHash(row: Row): Promise<'vended' | 'flagged' | 'pending'> {
  const txHash = String(row.x402_settle_tx).toLowerCase();
  const token = resolveTokenOnChain(row.token_used, normalizeChainName(row.blockchain), isMainnetEnv());
  const vault = vaultAddressFor(row.blockchain);
  if (!token || !vault) return 'pending';

  const proof = await verifyTokenTransfer(txHash, {
    blockchain: row.blockchain,
    tokenSymbol: row.token_used,
    from: row.x402_payer,
    to: vault,
    minAmountWei: parseUnits(Number(row.amount_usdt).toFixed(token.decimals), token.decimals),
  });

  if (!proof.ok && UNDECIDED_PROOF_FAILURES.has(proof.code)) return 'pending';

  if (!proof.ok) {
    await supabase.from('transactions').update({
      status: 'FAILED_VENDING', error_code: 'X402_TX_UNVERIFIED',
      api_response: `Facilitator reported ${txHash}, but: ${proof.detail}`.slice(0, 500),
    }).eq('id', row.id).eq('status', 'PENDING');
    await alert(`🚨 *x402 SETTLEMENT NOT FOUND ON-CHAIN (reconciler)*\n\`${proof.code}\`: ${proof.detail}\nIntent \`${row.tx_hash}\` — nothing vended, check by hand.`);
    return 'flagged';
  }

  const { data: locked, error: lockError } = await supabase.from('transactions')
    .update({ tx_hash: txHash, status: 'PROCESSING' })
    .eq('id', row.id).eq('status', 'PENDING')
    .select().maybeSingle();
  if (lockError?.code === '23505') {
    await alert(`🚨 *x402 SETTLEMENT HASH ALREADY CLAIMED (reconciler)*\n\`${txHash}\` is attached to another transaction — intent \`${row.tx_hash}\` not vended twice.`);
    return 'flagged';
  }
  if (!locked) return 'pending'; // another run or the route got there first

  // The same merchant-verify pass the route runs after settlement: a wrong-but-plausible
  // account is refunded rather than vended.
  const needsVerification = row.service_id !== 'foreign-airtime' && (
    row.service_category === 'ELECTRICITY' || row.service_category === 'BANK' ||
    (row.service_category === 'EDUCATION' && row.service_id === 'jamb') ||
    (row.service_category === 'CABLE' && row.network !== 'SHOWMAX')
  );
  if (needsVerification) {
    const verifyType = row.service_category === 'ELECTRICITY' ? (row.meter_account_type || undefined) : (row.variation_code || undefined);
    const va = await verifyAccount(row.service_id, row.account_number, verifyType);
    if (!va.success) {
      const reason = va.message || 'Could not verify that account.';
      await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'FAILED_VERIFICATION', api_response: reason }).eq('id', row.id);
      await enqueueRefund({
        transactionId: row.id, txHash, walletAddress: row.wallet_address, tokenUsed: row.token_used,
        amountCrypto: Number(row.amount_usdt), amountNaira: Number(row.amount_naira), blockchain: row.blockchain,
        reason, vtpassError: 'FAILED_VERIFICATION', userMessage: reason,
        serviceCategory: row.service_category, sourceChannel: row.source_channel || 'WEB',
      });
      return 'flagged';
    }
  }

  const { data: settings } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
  const baseRate = Number(settings?.exchange_rate) || 1500;
  await executeVend(vendInputFromRow(locked, { txHash, explorerUrl: `${explorerBaseFor(row.blockchain)}/tx/${txHash}`, baseRate }));
  await alert(`♻️ *x402 PAYMENT RECOVERED*\nIntent \`${row.tx_hash}\` was left open by an interrupted request; its settlement \`${txHash}\` is proven on-chain and has now been vended.`);
  return 'vended';
}

/** No hash: ask the token whether the authorization was ever spent. */
async function resolveWithoutHash(row: Row, now: number): Promise<'flagged' | 'expired' | 'pending'> {
  const state = await authorizationState(row);

  if (state === true) {
    // Money moved; nobody told us the transaction. Same treatment as the route's own
    // "paid but unconfirmed" branch: make it visible and flag it — never guess at a vend.
    await supabase.from('transactions').update({
      tx_hash: x402UnconfirmedKey(row.blockchain, row.x402_nonce),
      status: 'FAILED_VENDING', error_code: 'X402_SETTLED_UNCONFIRMED',
      api_response: 'Reconciler: the authorization was spent on-chain but no settlement hash was ever recorded. Needs manual reconciliation.',
    }).eq('id', row.id).eq('status', 'PENDING');
    await alert(`🚨 *x402 PAID BUT UNCONFIRMED (reconciler)*\nIntent \`${row.tx_hash}\`: the payer's authorization WAS spent, but no transaction hash was recorded. Reconcile by hand.\n${row.amount_usdt} ${row.token_used} · payer \`${row.x402_payer}\``);
    return 'flagged';
  }

  if (state === false) {
    const validBefore = row.x402_valid_before ? Date.parse(row.x402_valid_before) : NaN;
    // Unspent, and past its validBefore: the token will never accept it now. Closed as EXPIRED —
    // nothing moved, nothing to refund, and it stops counting as a pending payment.
    if (Number.isFinite(validBefore) && validBefore < now) {
      await supabase.from('transactions').update({
        status: 'EXPIRED', error_code: 'X402_NOT_SETTLED',
        api_response: 'Authorization expired unspent — the facilitator never settled it. Nothing was charged.',
      }).eq('id', row.id).eq('status', 'PENDING');
      return 'expired';
    }
    return 'pending'; // still spendable — the facilitator may yet land it
  }

  // Unreadable. Say so once if it stays that way, then keep trying.
  if (now - Date.parse(row.created_at) > UNREADABLE_ALERT_AFTER_MS && !row.error_code) {
    await supabase.from('transactions').update({ error_code: 'X402_STATE_UNREADABLE' }).eq('id', row.id).eq('status', 'PENDING');
    await alert(`⚠️ *x402 INTENT UNRESOLVED*\nIntent \`${row.tx_hash}\` has been open for over 30 min and the token's authorizationState can't be read. Check the RPC.`);
  }
  return 'pending';
}

/**
 * A refusal the chain proved unspent AT THE TIME is closed as FAILED_PAYMENT — but a facilitator
 * that had already queued the submission can still land it afterwards, until validBefore. That
 * must reach an operator: the payer is told it failed and may have paid again another way.
 */
async function watchRefusedIntents(now: number) {
  const { data: refused } = await supabase.from('transactions')
    .select('*')
    .eq('status', 'FAILED_PAYMENT')
    .eq('error_code', 'X402_SETTLE_REFUSED')
    .like('tx_hash', `${INTENT_PREFIX}%`)
    .gte('created_at', new Date(now - LATE_SETTLEMENT_WINDOW_MS).toISOString())
    .limit(BATCH);

  for (const row of (refused || []) as Row[]) {
    if ((await authorizationState(row)) !== true) continue;
    // Status stays FAILED_PAYMENT (terminal under migration 026); the error_code marks it seen.
    await supabase.from('transactions').update({
      error_code: 'X402_LATE_SETTLEMENT',
      api_response: 'The facilitator refused this payment, but the authorization was spent on-chain afterwards — the money moved. Refund or deliver by hand.',
    }).eq('id', row.id).eq('error_code', 'X402_SETTLE_REFUSED');
    await alert(`🚨 *x402 LATE SETTLEMENT*\nIntent \`${row.tx_hash}\` was refused, but its authorization was spent afterwards — the payer's money moved. They may have paid again via the fallback. Refund or deliver by hand.\n${row.amount_usdt} ${row.token_used} · payer \`${row.x402_payer}\``);
  }
}
