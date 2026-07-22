import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { getRemainingAllowance, relayPayBillFor } from '@/lib/deai/relayer';
import { fetchCryptoBalances } from '@/lib/deai/services';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { isMainnetEnv } from '@/lib/chain';

// ⚡ MULTI-RECIPIENT (BATCH) PAYMENTS — shared between the in-app chat (/api/deai/chat) and
// the social channels (/api/deai/core). The intent engine emits `recipients` whenever a user
// names 2+ people in one message ("send 500 airtime to 08011111111 and 1000 to 08033333333");
// both surfaces need the SAME capacity maths and grouping, so it lives here rather than being
// duplicated per route and drifting apart.
//
// A batch can freely mix chains/tokens per recipient, so capacity is checked PER (chain, token)
// group against that group's own subtotal — a Celo/USDC shortfall must not block a Base/USDT
// group that's perfectly funded.

export interface BatchItem {
  serviceCategory: string;
  serviceID: string;
  provider: string | null;
  billersCode: string;
  amountNgn: number;
  meterType?: string;
  chain: string;
  tokenSymbol: string;
}

export async function checkAutonomousCapacity(
  wallet: string, chain: string, tokenSymbol: string, totalNgn: number, exchangeRate: number
) {
  const neededCrypto = totalNgn / exchangeRate;
  const [allowance, balances] = await Promise.all([
    getRemainingAllowance(wallet, tokenSymbol, chain),
    fetchCryptoBalances(wallet, chain),
  ]);
  const balance = Number(balances[tokenSymbol] ?? 0);

  if (!allowance.ok || allowance.remaining < neededCrypto) {
    return {
      ok: false as const, neededCrypto, allowanceRemaining: allowance.ok ? allowance.remaining : 0, balance,
      reason: `You don't have enough approved agent limit for ${tokenSymbol} on ${chain} — need ${neededCrypto.toFixed(4)}, approved: ${allowance.ok ? allowance.remaining.toFixed(2) : '0'}.\n\nApprove a higher limit for ${tokenSymbol} on ${chain} in the Agent Hub tab, then ask me again.`,
    };
  }
  if (balance < neededCrypto) {
    return {
      ok: false as const, neededCrypto, allowanceRemaining: allowance.remaining, balance,
      reason: `Your ${tokenSymbol} balance (${balance.toFixed(2)}) on ${chain} won't cover this — you need about ${neededCrypto.toFixed(4)}. Top up first, then ask me again.`,
    };
  }
  return { ok: true as const, neededCrypto, allowanceRemaining: allowance.remaining, balance };
}

/** Groups items by (chain, token) — each group needs its own independent allowance/balance
 *  check against its own subtotal. */
export function groupByChainToken(items: BatchItem[]): Map<string, BatchItem[]> {
  const groups = new Map<string, BatchItem[]>();
  for (const item of items) {
    const key = `${item.chain}|${item.tokenSymbol}`;
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

export interface AgentPaymentResult {
  success: boolean;
  txHash?: string;
  /** True when the payment was BROADCAST but not confirmed — never safe to retry. */
  pending?: boolean;
  /** Set when the on-chain payment succeeded but delivering the service failed. */
  vendFailed?: boolean;
  message: string;
}

/**
 * Execute ONE agent-relayed bill payment end-to-end: write the pre-flight row, relay
 * payBillFor() on-chain, rename the row to the real hash, take the atomic PENDING->PROCESSING
 * lock, then vend.
 *
 * This mirrors the same sequence already inlined in /api/deai/core's "Path A" and in
 * scheduler.ts. Those two are deliberately NOT refactored to call this — they're live,
 * working money paths, and rewriting them belongs in its own change with its own testing,
 * not bundled into a feature addition. New batch code uses this; consolidating all three is
 * worthwhile follow-up.
 *
 * Every failure mode returns a result rather than throwing, so a batch can continue (or stop)
 * deliberately instead of dying half-way with no record of what already moved.
 */
export async function executeAgentPayment(params: {
  userWallet: string;
  item: BatchItem;
  exchangeRate: number;
  sourceChannel: string;
  email?: string | null;
  customerName?: string | null;
  customerAddress?: string | null;
  variationCode?: string | null;
}): Promise<AgentPaymentResult> {
  const { userWallet, item, exchangeRate, sourceChannel } = params;
  const amountCrypto = (item.amountNgn / exchangeRate).toFixed(6);
  const vtRequestId = getStrictRequestId();
  const explorerBase = item.chain === 'BASE'
    ? (isMainnetEnv() ? 'https://basescan.org' : 'https://sepolia.basescan.org')
    : (isMainnetEnv() ? 'https://celoscan.io' : 'https://sepolia.celoscan.io');

  let preflightTxHash: string | null = `preflight_${userWallet}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    await supabase.from('transactions').upsert({
      tx_hash: preflightTxHash, request_id: vtRequestId,
      service_category: item.serviceCategory, service_id: item.serviceID,
      variation_code: params.variationCode || null, network: item.provider || null, blockchain: item.chain,
      account_number: item.billersCode, phone: null,
      amount_usdt: Number(amountCrypto), amount_naira: item.amountNgn, fee_naira: 0, status: 'PENDING',
      wallet_address: userWallet.toLowerCase(),
      customer_name: params.customerName || null, customer_address: params.customerAddress || null,
      source_channel: sourceChannel, token_used: item.tokenSymbol,
      meter_account_type: item.meterType || null, customer_email: params.email || null,
      payment_method: 'AGENT_RELAY',
    }, { onConflict: 'tx_hash' });

    const res = await relayPayBillFor({
      userWallet,
      tokenSymbol: item.tokenSymbol,
      serviceType: item.serviceID,
      accountNumber: item.billersCode,
      amountCrypto,
      blockchain: item.chain,
      sourceChannel,
      amountNgn: item.amountNgn,
    });

    if (res.success) {
      const txHash = res.txHash as string;
      await supabase.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', preflightTxHash);
      preflightTxHash = null;

      const { data: locked } = await supabase.from('transactions')
        .update({ status: 'PROCESSING' })
        .eq('tx_hash', txHash).eq('status', 'PENDING').select().single();

      if (!locked) {
        // Something else (the webhook) already claimed this exact tx — it's vending. Report
        // success without vending a second time.
        return { success: true, txHash, message: 'Paid — finishing up in the background.' };
      }

      const vendResult = await executeVend({
        vtRequestId, txHash, serviceID: item.serviceID, serviceCategory: item.serviceCategory,
        network: item.provider || '', billersCode: item.billersCode, phone: null,
        variation_code: params.variationCode || undefined, subscription_type: undefined,
        amount: amountCrypto, tokenSymbol: item.tokenSymbol, vendAmount: item.amountNgn, isForeign: false,
        email: params.email || null, wallet_address: userWallet, blockchain: item.chain,
        source_channel: sourceChannel, customer_name: params.customerName || null,
        customer_address: params.customerAddress || null,
        baseRate: exchangeRate, explorerUrl: `${explorerBase}/tx/${txHash}`,
      });

      if (vendResult.status === 'FAILED_VENDING') {
        // Money DID move; delivery failed. The refund pipeline is already triggered inside
        // executeVend — say so plainly rather than implying nothing happened.
        return { success: false, vendFailed: true, txHash, message: vendResult.message || 'Paid, but delivery failed — a refund is on its way.' };
      }
      return { success: true, txHash, message: 'Paid' };
    }

    // Broadcast but unconfirmed — may still land. Keep the renamed row for the webhook.
    if (res.pending && res.txHash) {
      await supabase.from('transactions').update({ tx_hash: res.txHash }).eq('tx_hash', preflightTxHash);
      preflightTxHash = null;
      return { success: false, pending: true, txHash: res.txHash, message: 'Sent, still confirming — do not retry this one.' };
    }

    // Never broadcast — nothing charged. Clean up the pre-flight row.
    if (preflightTxHash) {
      await supabase.from('transactions').delete().eq('tx_hash', preflightTxHash);
      preflightTxHash = null;
    }
    return { success: false, message: res.message || 'Payment failed' };
  } catch (err: any) {
    if (preflightTxHash) {
      try { await supabase.from('transactions').delete().eq('tx_hash', preflightTxHash); } catch { /* best-effort */ }
    }
    console.error('[Batch] payment errored:', err?.message);
    return { success: false, message: 'Payment failed unexpectedly.' };
  }
}
