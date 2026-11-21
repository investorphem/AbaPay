import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { enqueueRefund } from '@/lib/refunds';
import { quoteCngn, settleQuote, sendCngn, fxConfigured, TOKEN_DECIMALS } from '@/lib/textileFx';
import { errorMessage } from '@/lib/errors';
import type { VendInput, VendResult } from '@/lib/vend';

// 🇳🇬 NAIRA AS cNGN, FOR VERIFIED AGENTS (migration 049).
//
// A verified agent's naira transfer is paid in USD stablecoins. AbaPay's FX wallet then buys exactly
// that many naira of cNGN on Textile FX (src/lib/textileFx.ts) and delivers it:
//   CNGN_PAYOUT     to the recipient's wallet: a cNGN transfer, delivered on chain (this file).
//   BANK_TREASURY   to the vault, backing a bank transfer (src/lib/bankPayouts.ts calls it).
// One fx_conversions row per order (unique), so a repeat call never converts twice: a row that
// already swapped only retries the delivery, and a delivered one is left alone.
//
// cNGN orders carry service_id CNGN_SERVICE_ID. executeVend hands them here, never to a provider;
// the stuck-order sweep and the fulfilment worker do the same (src/lib/reconcileStuck.ts).

export const CNGN_SERVICE_ID = 'abapay-cngn-payout';
export function isCngnOrder(serviceID: string | null | undefined): boolean {
  return serviceID === CNGN_SERVICE_ID;
}

export interface FxPolicy { enabled: boolean; maxUsdPerTx: number; dailyCapUsd: number; cngnPayout: boolean }
const FX_OFF: FxPolicy = { enabled: false, maxUsdPerTx: 0, dailyCapUsd: 0, cngnPayout: false };
export const FX_POLICY_COLUMNS = 'fx_enabled, fx_max_usd_per_tx, fx_daily_cap_usd, cngn_payout_enabled';
let cache: { value: FxPolicy; at: number } | null = null;

export async function getFxPolicy(): Promise<FxPolicy> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  try {
    const { data, error } = await supabase.from('platform_settings').select(FX_POLICY_COLUMNS).eq('id', 1).single();
    if (error || !data) throw new Error(error?.message || 'no settings row');
    const d = data as Record<string, unknown>;
    const value = { enabled: d.fx_enabled === true, maxUsdPerTx: Number(d.fx_max_usd_per_tx) || 0, dailyCapUsd: Number(d.fx_daily_cap_usd) || 0, cngnPayout: d.cngn_payout_enabled === true };
    cache = { value, at: Date.now() };
    return value;
  } catch (e) {
    console.error('[FX] could not read the settings, converting nothing:', errorMessage(e));
    return cache?.value ?? FX_OFF;
  }
}
export function clearFxPolicyCache() { cache = null; }

/** Whether a verified agent may order a cNGN transfer right now (switches on and the wallet set up). */
export async function cngnPayoutAvailable(): Promise<boolean> {
  const p = await getFxPolicy();
  return p.enabled && p.cngnPayout && fxConfigured();
}

type Purpose = 'BANK_TREASURY' | 'CNGN_PAYOUT';
type Conversion = { id: string; status: 'PENDING' | 'SWAPPED' | 'DELIVERED' | 'FAILED'; swap_tx: string | null; delivery_tx: string | null; cngn_amount: number; recipient: string };
export type ConvertResult =
  | { ok: true; swapTx: string; deliveryTx: string }
  | { ok: false; swapped: boolean; reason: string };

const atomic = (ngn: number) => BigInt(Math.round(ngn * 10 ** TOKEN_DECIMALS));

async function usdSoldLast24h(): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await supabase.from('fx_conversions').select('usd_sold').in('status', ['SWAPPED', 'DELIVERED']).gte('created_at', since);
  if (error) throw new Error(`conversion history read failed: ${error.message}`);
  return ((data || []) as { usd_sold: number | null }[]).reduce((t, r) => t + Number(r.usd_sold || 0), 0) / 10 ** TOKEN_DECIMALS;
}

const update = (id: string, patch: Record<string, unknown>) =>
  supabase.from('fx_conversions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);

/**
 * Buy `amountNgn` of cNGN for this order and deliver it to `recipient`. Idempotent per order.
 * Never throws. `swapped` on a failure says whether the USD₮ was already spent.
 */
export async function convertForOrder(p: { transactionId: string; purpose: Purpose; recipient: `0x${string}`; amountNgn: number }): Promise<ConvertResult> {
  try {
    const policy = await getFxPolicy();
    let { data: row } = await supabase.from('fx_conversions').select('id, status, swap_tx, delivery_tx, cngn_amount, recipient').eq('transaction_id', p.transactionId).maybeSingle();
    let conv = row as Conversion | null;
    if (conv?.status === 'DELIVERED') return { ok: true, swapTx: String(conv.swap_tx), deliveryTx: String(conv.delivery_tx) };

    if (!conv || conv.status === 'PENDING' || conv.status === 'FAILED') {
      if (!policy.enabled || !fxConfigured()) return { ok: false, swapped: false, reason: 'Conversions are switched off.' };
      if (!conv) {
        const ins = await supabase.from('fx_conversions').insert({ transaction_id: p.transactionId, purpose: p.purpose, recipient: p.recipient.toLowerCase(), cngn_amount: p.amountNgn, status: 'PENDING' }).select('id, status, swap_tx, delivery_tx, cngn_amount, recipient').maybeSingle();
        if (ins.error) {
          if (ins.error.code !== '23505') throw new Error(ins.error.message);
          ({ data: row } = await supabase.from('fx_conversions').select('id, status, swap_tx, delivery_tx, cngn_amount, recipient').eq('transaction_id', p.transactionId).maybeSingle());
          conv = row as Conversion | null;
          if (!conv || conv.status !== 'PENDING') return { ok: false, swapped: conv?.status === 'SWAPPED', reason: 'This conversion is already being handled.' };
        } else {
          conv = ins.data as Conversion;
        }
      }
      const quote = await quoteCngn(atomic(p.amountNgn));
      if (!quote.ok) { await update(conv.id, { status: 'FAILED', error: quote.reason }); return { ok: false, swapped: false, reason: quote.reason }; }
      const usd = Number(quote.quote.takerPays) / 10 ** TOKEN_DECIMALS;
      if (usd > policy.maxUsdPerTx) {
        const reason = `The conversion ($${usd.toFixed(2)}) is above the $${policy.maxUsdPerTx} per-conversion limit.`;
        await update(conv.id, { status: 'FAILED', error: reason });
        return { ok: false, swapped: false, reason };
      }
      if ((await usdSoldLast24h()) + usd > policy.dailyCapUsd) {
        const reason = `The FX wallet's $${policy.dailyCapUsd} daily limit is reached.`;
        await update(conv.id, { status: 'FAILED', error: reason });
        return { ok: false, swapped: false, reason };
      }
      const swap = await settleQuote(quote.quote);
      if (!swap.ok) {
        // A swap that was sent but reverted moved nothing; one that settled short is reported as swapped.
        const swapped = !!swap.swapTx && /less cNGN/.test(swap.reason);
        await update(conv.id, { status: swapped ? 'SWAPPED' : 'FAILED', swap_tx: swap.swapTx ?? null, error: swap.reason });
        return { ok: false, swapped, reason: swap.reason };
      }
      await update(conv.id, { status: 'SWAPPED', swap_tx: swap.swapTx, usd_sold: Number(swap.usdSold), rfq_id: quote.quote.rfqId, error: null });
      conv = { ...conv, status: 'SWAPPED', swap_tx: swap.swapTx };
    }

    // SWAPPED: the cNGN is in the FX wallet. Deliver it (this is also the retry of a failed delivery).
    const sent = await sendCngn(conv.recipient as `0x${string}`, atomic(Number(conv.cngn_amount)));
    if (!sent.ok) {
      await update(conv.id, { error: sent.reason, delivery_tx: sent.tx ?? null });
      return { ok: false, swapped: true, reason: sent.reason };
    }
    await update(conv.id, { status: 'DELIVERED', delivery_tx: sent.tx, error: null });
    return { ok: true, swapTx: String(conv.swap_tx), deliveryTx: sent.tx };
  } catch (e) {
    return { ok: false, swapped: false, reason: errorMessage(e).slice(0, 200) };
  }
}

type TxRow = {
  id: string; tx_hash: string; status: string; wallet_address: string | null; account_number: string | null; amount_naira: number | null;
  amount_usdt: number | null; token_used: string | null; blockchain: string | null; source_channel: string | null; self_agent_id: string | null;
};

/** executeVend's branch for a cNGN transfer. Never calls a bill provider. Never throws. */
export async function deliverCngnOrder(input: VendInput): Promise<VendResult> {
  const { data } = await supabase.from('transactions').select('*').eq('tx_hash', input.txHash).maybeSingle();
  const tx = data as TxRow | null;
  if (!tx) return { success: true, status: 'TIMEOUT', message: 'Paid. The cNGN transfer is being prepared; check its status shortly. Do not pay again.' };
  if (tx.status === 'SUCCESS') return { success: true, status: 'SUCCESS', message: 'cNGN delivered.' };
  if (tx.status !== 'PROCESSING') return { success: true, status: 'TIMEOUT', message: 'This payment is not confirmed yet; the cNGN is sent once it is. Do not pay again.' };
  const recipient = String(tx.account_number || '');
  if (!tx.self_agent_id || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) return refundOrder(tx, 'cNGN transfer without a verified Self Agent ID or a valid recipient wallet.');

  const r = await convertForOrder({ transactionId: tx.id, purpose: 'CNGN_PAYOUT', recipient: recipient as `0x${string}`, amountNgn: Number(tx.amount_naira) });
  if (r.ok) {
    await supabase.from('transactions').update({ status: 'SUCCESS', purchased_code: `cNGN sent: ${r.deliveryTx}`, api_response: `Converted on Textile FX (${r.swapTx}) and sent.` })
      .eq('id', tx.id).eq('status', 'PROCESSING');
    return { success: true, status: 'SUCCESS', message: `Sent ₦${Number(tx.amount_naira).toLocaleString()} as cNGN to ${recipient}. Transaction: ${r.deliveryTx}` };
  }
  if (!r.swapped) return refundOrder(tx, r.reason);
  // The USD₮ is spent and the cNGN sits in the FX wallet: never refund twice. The delivery is retried
  // by the fulfilment worker (reconcileStuck), and the operator is told.
  await sendTelegramAlert(`⚠️ *cNGN DELIVERY PENDING*\nOrder \`${tx.tx_hash}\`: converted, but sending ₦${Number(tx.amount_naira).toLocaleString()} cNGN to \`${recipient}\` failed: ${r.reason}\nIt is retried automatically.`).catch(() => {});
  return { success: true, status: 'TIMEOUT', message: 'Paid. The cNGN is being sent; check its status shortly. Do not pay again.' };
}

async function refundOrder(tx: TxRow, reason: string): Promise<VendResult> {
  await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'CNGN_PAYOUT_FAILED', api_response: reason }).eq('id', tx.id).eq('status', 'PROCESSING');
  await enqueueRefund({
    txHash: tx.tx_hash, walletAddress: String(tx.wallet_address || ''), tokenUsed: String(tx.token_used || 'USD₮'),
    amountCrypto: Number(tx.amount_usdt || 0), amountNaira: Number(tx.amount_naira || 0), blockchain: tx.blockchain || 'CELO',
    reason, serviceCategory: 'CNGN', sourceChannel: tx.source_channel || 'AGENT', transactionId: tx.id,
  });
  return { success: false, status: 'FAILED_VENDING', message: `The cNGN transfer could not be sent (${reason}). A refund is on its way.` };
}
