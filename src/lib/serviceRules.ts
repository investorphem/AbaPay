import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';

// ⚡ SHARED SERVICE RULES — one source of truth for the app AND the agent.
//
// 🔴 THE BUG THIS FIXES:
// The web app checked `kill_switches` before letting a user pay. The DeAI agent did NOT.
// So if an operator disabled ELECTRICITY (VTpass outage, fraud, provider dispute), the
// website correctly blocked it — but the bot would happily take the user's money and try
// to vend a service that was knowingly switched off.
//
// That was survivable when the agent could only hand out deep links. It is NOT survivable
// now that AbaPayV3's relayer can actually spend a user's allowance: the agent would be
// spending real funds on a service the operator has explicitly disabled.
//
// Every rule the frontend enforces must be enforced here too, server-side, on the agent's
// path. The agent is a client like any other — it does not get to skip the rules.

export interface ServiceRules {
  killSwitches: Record<string, boolean>;
  exchangeRate: number;
  // ⚡ Operator controls over the DeAI agent. These matter now that it can SPEND.
  agentEnabled: boolean;              // master kill for ALL agent payments
  agentAutonomousEnabled: boolean;    // kill only unattended/scheduled execution
  agentMaxNgnPerTx: number;           // operator ceiling on a single agent payment
  agentDailyCapNgn: number;           // operator ceiling per user, per day
  aiChatEnabled: boolean;             // in-app chat widget
}

let cache: { rules: ServiceRules; at: number } | null = null;
const CACHE_MS = 30_000; // brief cache; an operator flipping a kill switch takes effect within 30s

export async function getServiceRules(): Promise<ServiceRules> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rules;

  const fallback: ServiceRules = {
    killSwitches: {},
    exchangeRate: Number(process.env.NEXT_PUBLIC_FIXED_RATE) || 1550,
    agentEnabled: true,
    agentAutonomousEnabled: true,
    agentMaxNgnPerTx: 50_000,
    agentDailyCapNgn: 100_000,
    aiChatEnabled: true,
  };

  try {
    const { data } = await supabaseAdmin
      .from('platform_settings')
      .select('exchange_rate, kill_switches, agent_enabled, agent_autonomous_enabled, agent_max_ngn_per_tx, agent_daily_cap_ngn, ai_chat_enabled')
      .eq('id', 1)
      .single();

    if (!data) return fallback;

    const d = data as any;
    const rules: ServiceRules = {
      killSwitches: (d.kill_switches as Record<string, boolean>) || {},
      exchangeRate: Number(d.exchange_rate) || fallback.exchangeRate,
      agentEnabled: d.agent_enabled !== false,
      agentAutonomousEnabled: d.agent_autonomous_enabled !== false,
      agentMaxNgnPerTx: Number(d.agent_max_ngn_per_tx) || fallback.agentMaxNgnPerTx,
      agentDailyCapNgn: Number(d.agent_daily_cap_ngn) || fallback.agentDailyCapNgn,
      aiChatEnabled: d.ai_chat_enabled !== false,
    };

    cache = { rules, at: Date.now() };
    return rules;
  } catch (err) {
    console.error('[Rules] Failed to load platform settings:', err);
    return fallback;
  }
}

/**
 * Map an agent intent to the kill-switch key the operator toggles in the admin dashboard.
 */
export function killSwitchKeyFor(intent: string): string | null {
  switch (intent) {
    case 'VEND_AIRTIME': return 'AIRTIME';
    case 'VEND_DATA':    return 'INTERNET';
    case 'ELECTRICITY':  return 'ELECTRICITY';
    case 'TV':           return 'CABLE';
    case 'BANK_TRANSFER':return 'BANK';
    case 'EDUCATION':    return 'EDUCATION';
    default:             return null;
  }
}

export interface RuleCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * The gate the agent MUST pass before it promises — or executes — any payment.
 */
export async function checkServiceAllowed(intent: string, opts: { isInternational?: boolean } = {}): Promise<RuleCheck> {
  const rules = await getServiceRules();

  if (opts.isInternational) {
    // International is gated by its own master switch.
    if (rules.killSwitches.MASTER_INTERNATIONAL === false) {
      return { allowed: false, reason: 'International payments are temporarily unavailable. Please try again later.' };
    }
  }

  const key = killSwitchKeyFor(intent);
  if (!key) return { allowed: true }; // non-payment intents (balance, history, help)

  // A switch is "on" unless explicitly set to false. Missing key = enabled (matches the app).
  if (rules.killSwitches[key] === false) {
    const label = key.charAt(0) + key.slice(1).toLowerCase();
    return {
      allowed: false,
      reason: `${label} payments are temporarily unavailable while we resolve an issue with our provider. Please try again shortly.`,
    };
  }

  return { allowed: true };
}

/**
 * Minimum spend per service, mirroring the web app's limits.
 */
export function minAmountFor(intent: string): number {
  switch (intent) {
    case 'VEND_AIRTIME': return 50;
    case 'ELECTRICITY':  return 500;
    case 'TV':           return 100;
    case 'BANK_TRANSFER':return 100;
    default:             return 100;
  }
}

const MAX_AMOUNT_NGN = 500_000;

export function checkAmount(intent: string, amountNgn: number, verifiedMin?: number | null): RuleCheck {
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    return { allowed: false, reason: 'Please give me a valid amount.' };
  }

  // VTpass sometimes returns a provider-specific minimum (e.g. a postpaid balance owed).
  const min = Math.max(minAmountFor(intent), Number(verifiedMin) || 0);

  if (amountNgn < min) {
    return { allowed: false, reason: `The minimum for this service is ₦${min.toLocaleString()}.` };
  }
  if (amountNgn > MAX_AMOUNT_NGN) {
    return { allowed: false, reason: `That's above the ₦${MAX_AMOUNT_NGN.toLocaleString()} per-transaction limit.` };
  }

  return { allowed: true };
}


export interface AgentSpendCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * ⚡ OPERATOR GATE ON AGENT SPENDING.
 *
 * Runs before the relayer moves a single cent. This is the operator's emergency brake —
 * they can halt all agent payments, or just autonomous ones, instantly from the admin
 * dashboard without a redeploy or a contract call.
 *
 * Layered ON TOP of the on-chain allowance, not instead of it: even if every check here
 * were bypassed, AbaPayV3 still refuses to spend beyond what the user personally signed for.
 */
export async function checkAgentSpendAllowed(
  supabase: any,
  walletAddress: string,
  amountNgn: number,
  opts: { autonomous?: boolean } = {}
): Promise<AgentSpendCheck> {
  const rules = await getServiceRules();

  if (!rules.agentEnabled) {
    return { allowed: false, reason: 'Agent payments are temporarily disabled. You can still pay in the AbaPay app.' };
  }

  if (opts.autonomous && !rules.agentAutonomousEnabled) {
    return { allowed: false, reason: 'Automatic payments are temporarily paused. I\'ll send you a link to approve instead.' };
  }

  if (amountNgn > rules.agentMaxNgnPerTx) {
    return {
      allowed: false,
      reason: `Agent payments are capped at ₦${rules.agentMaxNgnPerTx.toLocaleString()} per transaction. Please pay this one in the app.`,
    };
  }

  // Per-user daily cap — bounds the damage from a compromised PIN or relayer.
  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('transactions')
      .select('amount_naira')
      .ilike('wallet_address', walletAddress)
      .in('status', ['SUCCESS', 'PENDING', 'PROCESSING'])
      .gte('created_at', startOfDay.toISOString());

    const spentToday = (data || []).reduce((sum: number, t: any) => sum + Number(t.amount_naira || 0), 0);

    if (spentToday + amountNgn > rules.agentDailyCapNgn) {
      return {
        allowed: false,
        reason: `That would take you over the ₦${rules.agentDailyCapNgn.toLocaleString()} daily agent limit (you've used ₦${spentToday.toLocaleString()} today). You can still pay in the app.`,
      };
    }
  } catch {
    // A lookup failure must not block a legitimate payment — the on-chain cap still holds.
  }

  return { allowed: true };
}
