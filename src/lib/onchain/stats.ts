import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import type { OnchainChain } from './config';

// Reads onchain_summary() (supabase/migrations/038_onchain_payments.sql): every number on
// /agents/stats and the agents home page, in one query. Returns null when the database can't be
// reached, so a page can say so instead of showing zeros that look like real data.

type Num = number | string;

export type OnchainSummary = {
  totals: { payments: number; wallets: number; volume_usd: Num; agent_volume_usd: Num; first_payment: string | null; last_payment: string | null };
  last30: { payments: number; wallets: number; volume_usd: Num };
  by_rail: { rail: 'direct' | 'agent' | 'x402'; payments: number; wallets: number; volume_usd: Num }[];
  by_contract: { chain: OnchainChain; contract: string; contract_label: string; payments: number; wallets: number; volume_usd: Num; first_payment: string; last_payment: string }[];
  by_token: { token_symbol: string; payments: number; volume_usd: Num }[];
  /** Added by 039; absent if only 038 is applied. */
  by_service?: { service_type: string; payments: number; volume_usd: Num }[];
  tags: { tag: string; payments: number; last_payment: string }[];
  daily: {
    day: string; direct: number; agent: number; x402: number; wallets: number; volume_usd: Num; new_wallets: number;
    /** Added by 039. */
    volume_direct?: Num; volume_agent?: Num; volume_x402?: Num;
  }[];
  cursors: { chain: OnchainChain; last_block: number; head_block: number | null; updated_at: string }[];
};

export async function getOnchainSummary(chain: OnchainChain | null): Promise<OnchainSummary | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('onchain_summary', { p_chain: chain });
    if (error || !data) return null;
    return data as OnchainSummary;
  } catch {
    return null;
  }
}

export type WindowKey = '7' | '30' | '90' | 'all';

export type OnchainWindow = {
  payments: number; wallets: number; new_wallets: number; volume_usd: Num; agent_volume_usd: Num;
  by_rail: { rail: 'direct' | 'agent' | 'x402'; payments: number; wallets: number; volume_usd: Num }[];
  by_token: { token_symbol: string; payments: number; volume_usd: Num }[];
  by_chain: { chain: OnchainChain; payments: number; volume_usd: Num }[];
  tags: { tag: string; payments: number; last_payment: string }[];
};

/** onchain_windows() (supabase/migrations/041_onchain_windows.sql): the range-switched numbers on stats.abapays.com. */
export type OnchainWindows = {
  windows: Record<WindowKey, OnchainWindow>;
  /** One row per Lagos day, first payment to today: distinct paying wallets that day, in the 7 days and in the 30 days ending it. */
  active: { day: string; dau: number; wau: number; mau: number }[];
};

/** Null when the database can't be reached or 041 isn't applied yet; the page then shows all-time numbers only. */
export async function getOnchainWindows(chain: OnchainChain | null): Promise<OnchainWindows | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('onchain_windows', { p_chain: chain });
    if (error || !data) return null;
    return data as OnchainWindows;
  } catch {
    return null;
  }
}

export type LatestPayment = {
  chain: OnchainChain;
  tx_hash: string;
  log_index: number;
  block_time: string;
  contract_label: string;
  payer: string;
  token_symbol: string;
  amount_usd: Num;
  rail: 'direct' | 'agent' | 'x402';
  tags: string[];
};

/** The newest payments on one chain, or on both when chain is null. */
export async function getLatestPayments(chain: OnchainChain | null, limit = 20): Promise<LatestPayment[]> {
  try {
    let q = supabaseAdmin
      .from('onchain_payments')
      .select('chain, tx_hash, log_index, block_time, contract_label, payer, token_symbol, amount_usd, rail, tags');
    if (chain) q = q.eq('chain', chain);
    const { data, error } = await q.order('block_time', { ascending: false }).limit(limit);
    if (error || !data) return [];
    return data as LatestPayment[];
  } catch {
    return [];
  }
}

export const RAIL_LABEL: Record<'direct' | 'agent' | 'x402', string> = {
  x402: 'x402',
  agent: 'Agent (relayer)',
  direct: 'Direct (wallet)',
};
