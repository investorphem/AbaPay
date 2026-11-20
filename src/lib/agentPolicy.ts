import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import type { SelfAgentStatus } from '@/lib/selfAgent';

// 🪪 OUTSIDE-AGENT TERMS — what an agent paying through x402, MCP or A2A gets, decided by whether
// its request carries a Self Agent ID the registry confirms (src/lib/selfAgent.ts).
//
// Separate from everything else on purpose: web and MiniPay customers, and AbaPay's own chat agent
// (Telegram, WhatsApp, X, the scheduler), never read these settings. The operator sets them in
// Admin → Agent → Outside agents (migration 048). Every switch starts off and every cap empty.
//
// Verified agents can get, each behind its own switch:
//   - discount campaigns (the same engine and caps as the web app),
//   - no x402 facilitator fee,
//   - their own, higher caps (empty = none),
//   - bank transfers, with no cap.
// Unverified agents get none of these, and the outside-agent caps apply to them.
//
// Reading the settings fails closed: no perks, no bank transfers, and no caps that nobody set.

export interface AgentPolicy {
  extMaxNgnPerTx: number | null;
  extDailyCapNgn: number | null;
  verifiedDiscounts: boolean;
  verifiedFeeWaiver: boolean;
  verifiedHigherLimits: boolean;
  verifiedMaxNgnPerTx: number | null;
  verifiedDailyCapNgn: number | null;
  verifiedBank: boolean;
}

export const POLICY_OFF: AgentPolicy = {
  extMaxNgnPerTx: null, extDailyCapNgn: null,
  verifiedDiscounts: false, verifiedFeeWaiver: false, verifiedHigherLimits: false,
  verifiedMaxNgnPerTx: null, verifiedDailyCapNgn: null, verifiedBank: false,
};

const CACHE_MS = 30_000;
let cache: { value: AgentPolicy; at: number } | null = null;

const cap = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? n : null;
};

export const POLICY_COLUMNS = 'agent_ext_max_ngn_per_tx, agent_ext_daily_cap_ngn, verified_agent_discounts_enabled, verified_agent_fee_waiver_enabled, verified_agent_higher_limits_enabled, verified_agent_max_ngn_per_tx, verified_agent_daily_cap_ngn, verified_agent_bank_enabled';

export function policyFromRow(d: Record<string, unknown> | null | undefined): AgentPolicy {
  if (!d) return POLICY_OFF;
  return {
    extMaxNgnPerTx: cap(d.agent_ext_max_ngn_per_tx),
    extDailyCapNgn: cap(d.agent_ext_daily_cap_ngn),
    verifiedDiscounts: d.verified_agent_discounts_enabled === true,
    verifiedFeeWaiver: d.verified_agent_fee_waiver_enabled === true,
    verifiedHigherLimits: d.verified_agent_higher_limits_enabled === true,
    verifiedMaxNgnPerTx: cap(d.verified_agent_max_ngn_per_tx),
    verifiedDailyCapNgn: cap(d.verified_agent_daily_cap_ngn),
    verifiedBank: d.verified_agent_bank_enabled === true,
  };
}

export async function getAgentPolicy(): Promise<AgentPolicy> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const { data, error } = await supabaseAdmin.from('platform_settings').select(POLICY_COLUMNS).eq('id', 1).single();
    if (error) throw new Error(error.message);
    const value = policyFromRow(data as Record<string, unknown>);
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error('[AgentPolicy] could not read the settings, applying none:', err);
    return cache?.value ?? POLICY_OFF;
  }
}

/** For the admin route after a save, so the next payment on this instance sees it at once. */
export function clearAgentPolicyCache() { cache = null; }

export interface AgentTerms {
  verified: boolean;
  selfAgentId: string | null;
  selfAgentAddress: string | null;
  discounts: boolean;
  feeWaived: boolean;
  maxNgnPerTx: number | null;
  dailyCapNgn: number | null;
  bankAllowed: boolean;
}

/** What this request's agent gets. Only a `verified` Self result counts; anything else is unverified. */
export function agentTerms(self: SelfAgentStatus, policy: AgentPolicy): AgentTerms {
  const verified = self.present && self.status === 'verified';
  const selfAgentId = verified && 'agentId' in self ? self.agentId : null;
  const selfAgentAddress = verified && 'agentAddress' in self ? (self.agentAddress ?? null) : null;
  if (!verified) {
    return {
      verified: false, selfAgentId: null, selfAgentAddress: null, discounts: false, feeWaived: false,
      maxNgnPerTx: policy.extMaxNgnPerTx, dailyCapNgn: policy.extDailyCapNgn, bankAllowed: false,
    };
  }
  return {
    verified: true, selfAgentId, selfAgentAddress,
    discounts: policy.verifiedDiscounts,
    feeWaived: policy.verifiedFeeWaiver,
    maxNgnPerTx: policy.verifiedHigherLimits ? policy.verifiedMaxNgnPerTx : policy.extMaxNgnPerTx,
    dailyCapNgn: policy.verifiedHigherLimits ? policy.verifiedDailyCapNgn : policy.extDailyCapNgn,
    bankAllowed: policy.verifiedBank,
  };
}

// Orders that count toward a daily cap: paid and delivered, or paid and still being delivered.
// Refunded and never-paid orders don't count. A verified agent's bank transfers have no cap and
// don't count either.
const CAP_STATUSES = ['SUCCESS', 'PROCESSING', 'AWAITING_PAYOUT'];
const AGENT_CHANNELS = ['AGENT', 'MCP', 'A2A'];

export type CapCheck = { allowed: true } | { allowed: false; code: 'AGENT_LIMIT'; reason: string };

/**
 * Whether `amountNgn` fits this agent's caps. The daily cap is a rolling 24 hours of the paying
 * wallet's outside-agent orders. A verified agent's bank transfer is never capped.
 */
export async function checkAgentCaps(p: { terms: AgentTerms; wallet: string | null | undefined; amountNgn: number; isBank: boolean; now?: number }): Promise<CapCheck> {
  const { terms } = p;
  if (p.isBank && terms.verified && terms.bankAllowed) return { allowed: true };
  const fix = terms.verified ? '' : ' A verified Self Agent ID can raise this: see docs.abapays.com → Self Agent ID.';
  if (terms.maxNgnPerTx !== null && p.amountNgn > terms.maxNgnPerTx) {
    return { allowed: false, code: 'AGENT_LIMIT', reason: `The most an agent can pay in one order is ₦${terms.maxNgnPerTx.toLocaleString()}. Nothing was charged.${fix}` };
  }
  if (terms.dailyCapNgn !== null) {
    if (!p.wallet) return { allowed: false, code: 'AGENT_LIMIT', reason: 'This payment needs the paying wallet_address so its daily limit can be checked. Nothing was charged.' };
    const since = new Date((p.now ?? Date.now()) - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin.from('transactions')
      .select('amount_naira, service_category, self_agent_id')
      .eq('wallet_address', p.wallet.toLowerCase())
      .in('source_channel', AGENT_CHANNELS)
      .in('status', CAP_STATUSES)
      .gte('created_at', since);
    if (error) return { allowed: false, code: 'AGENT_LIMIT', reason: 'The daily limit could not be checked right now. Nothing was charged; try again shortly.' };
    const rows = (data || []) as { amount_naira: number | null; service_category: string | null; self_agent_id: string | null }[];
    const used = rows
      .filter((r) => !(r.service_category === 'BANK' && r.self_agent_id))
      .reduce((t, r) => t + Number(r.amount_naira || 0), 0);
    if (used + p.amountNgn > terms.dailyCapNgn) {
      const left = Math.max(0, terms.dailyCapNgn - used);
      return { allowed: false, code: 'AGENT_LIMIT', reason: `This would pass the ₦${terms.dailyCapNgn.toLocaleString()} daily limit for this wallet (₦${left.toLocaleString()} left in the last 24 hours). Nothing was charged.${fix}` };
    }
  }
  return { allowed: true };
}
