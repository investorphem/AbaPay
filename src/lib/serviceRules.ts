import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { resolveServiceId } from '@/lib/deai/services';

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

// 🔴 THE BUG THIS FIXES: the admin dashboard's "pause a service" switches did NOTHING to
// chat, MCP or the scheduler.
//
// The dashboard (src/app/admin/page.tsx ~L851) writes a TWO-LEVEL key system into
// platform_settings.kill_switches: a per-service master (`MASTER_AIRTIME`,
// `MASTER_INTERNET`, `MASTER_ELECTRICITY`, `MASTER_CABLE`, `MASTER_EDUCATION`,
// `MASTER_INTERNATIONAL`) and a per-provider switch keyed by VTpass serviceID
// (`AIRTIME_mtn`, `INTERNET_airtel-data`, `ELEC_ikeja-electric`, `CABLE_dstv`, `EDU_waec`).
// The web app (src/app/page.tsx ~L216) blocks when EITHER is false.
//
// This function used to return a single BARE key — 'AIRTIME', 'INTERNET', 'ELECTRICITY',
// 'CABLE', 'EDUCATION' — with no prefix. NOTHING has written those keys since the
// MASTER_/per-provider system replaced them; they survive in production only as dead legacy
// data, all set to true. So an operator hitting "pause Electricity" in the dashboard flipped
// `MASTER_ELECTRICITY`, which nothing on the agent's path ever read: the website correctly
// refused, while chat, MCP and the autonomous scheduler carried on spending real user funds
// on a service the operator had deliberately switched off. Exactly the failure the top of
// this file says it exists to prevent — reintroduced by a key rename on the dashboard side.
//
// Keys below are copied from admin/page.tsx verbatim. Note DATA's master is MASTER_INTERNET
// and its provider prefix is INTERNET_ — that is what the dashboard and the web app call it.
const KILL_SWITCHES: Record<string, { master: string; providerPrefix?: string; label: string }> = {
  VEND_AIRTIME:    { master: 'MASTER_AIRTIME',       providerPrefix: 'AIRTIME',  label: 'Airtime' },
  VEND_DATA:       { master: 'MASTER_INTERNET',      providerPrefix: 'INTERNET', label: 'Data' },
  ELECTRICITY:     { master: 'MASTER_ELECTRICITY',   providerPrefix: 'ELEC',     label: 'Electricity' },
  PAY_ELECTRICITY: { master: 'MASTER_ELECTRICITY',   providerPrefix: 'ELEC',     label: 'Electricity' },
  TV:              { master: 'MASTER_CABLE',         providerPrefix: 'CABLE',    label: 'Cable TV' },
  PAY_CABLE:       { master: 'MASTER_CABLE',         providerPrefix: 'CABLE',    label: 'Cable TV' },
  EDUCATION:       { master: 'MASTER_EDUCATION',     providerPrefix: 'EDU',      label: 'Education' },
  // International has a master switch in the dashboard but no per-provider breakdown.
  INTERNATIONAL:   { master: 'MASTER_INTERNATIONAL', label: 'International airtime' },
  // ⚠️ Bank transfer has NO toggle in the admin dashboard (no group in admin/page.tsx, and
  // page.tsx's isCurrentServiceDisabled doesn't check it either). Left on the pre-existing
  // bare 'BANK' key rather than inventing a MASTER_BANK switch no operator can reach — if a
  // bank group is ever added to the dashboard, point this at whatever key it writes.
  BANK_TRANSFER:   { master: 'BANK', label: 'Bank transfer' },
};

export interface KillSwitchKeys {
  /** The dashboard's per-service master toggle. */
  master: string;
  /** The dashboard's per-provider toggle, or null when no provider was supplied/applies. */
  provider: string | null;
  /** Human-readable service name, for the refusal message. */
  label: string;
}

/**
 * Map an agent intent (+ the provider, when known) to the kill-switch keys the operator
 * actually toggles in the admin dashboard.
 *
 * The provider is normalised through resolveServiceId — the same function that turns an
 * agent's loose provider ("ikeja", "mtn") into the VTpass serviceID ("ikeja-electric",
 * "mtn") the vend uses — because the dashboard keys its per-provider switches by serviceID.
 * Without that, `ELEC_ikeja` would silently never match the `ELEC_ikeja-electric` the
 * operator switched off.
 */
export function killSwitchKeysFor(intent: string, provider?: string | null): KillSwitchKeys | null {
  const spec = KILL_SWITCHES[intent];
  if (!spec) return null; // non-payment intents (balance, history, help)

  let providerKey: string | null = null;
  if (spec.providerPrefix && provider) {
    const serviceID = resolveServiceId(intent, provider) || String(provider);
    providerKey = `${spec.providerPrefix}_${serviceID.toLowerCase()}`;
  }

  return { master: spec.master, provider: providerKey, label: spec.label };
}

export interface RuleCheck {
  allowed: boolean;
  reason?: string;
}

// ⚡ CHANNEL KILL SWITCHES — separate from the service switches above. Those pause a
// PRODUCT (airtime, electricity...) everywhere at once; these pause an entire CHANNEL
// (e.g. "WhatsApp is down / being maintained, stop routing traffic through it") without
// touching the same users' access via Telegram, X, MCP or the web app.
//
// Keys live in the same platform_settings.kill_switches jsonb, prefixed CHANNEL_ so they
// can never collide with a service key. Missing key = enabled, exactly like every other
// switch in this file — an operator who never touches this section shouldn't have every
// channel silently go dark.
const CHANNEL_KEYS: Record<'WHATSAPP' | 'TELEGRAM' | 'X' | 'MCP' | 'A2A', string> = {
  WHATSAPP: 'CHANNEL_WHATSAPP',
  TELEGRAM: 'CHANNEL_TELEGRAM',
  X: 'CHANNEL_X',
  MCP: 'CHANNEL_MCP',
  // A2A is a separate agent surface from MCP with its own blast radius — pausing one must not
  // pause the other. No migration needed: kill_switches is a free-form JSONB map and a missing
  // key reads as enabled (see below), so this switch simply starts on.
  A2A: 'CHANNEL_A2A',
};

export async function isChannelEnabled(channel: 'WHATSAPP' | 'TELEGRAM' | 'X' | 'MCP' | 'A2A'): Promise<boolean> {
  const rules = await getServiceRules();
  return rules.killSwitches[CHANNEL_KEYS[channel]] !== false;
}

/**
 * The gate the agent MUST pass before it promises — or executes — any payment.
 */
export async function checkServiceAllowed(
  intent: string,
  provider?: string | null,
  opts: { isInternational?: boolean } = {}
): Promise<RuleCheck> {
  const rules = await getServiceRules();

  if (opts.isInternational) {
    // International is gated by its own master switch.
    if (rules.killSwitches.MASTER_INTERNATIONAL === false) {
      return { allowed: false, reason: 'International payments are temporarily unavailable. Please try again later.' };
    }
  }

  const keys = killSwitchKeysFor(intent, provider);
  if (!keys) return { allowed: true }; // non-payment intents (balance, history, help)

  // A switch is "on" unless explicitly set to false. Missing key = enabled (matches the app).
  // Blocked at EITHER level — the whole service, or just this one provider — exactly as
  // page.tsx's isCurrentServiceDisabled does with its `||`.
  const masterOff = rules.killSwitches[keys.master] === false;
  const providerOff = !!keys.provider && rules.killSwitches[keys.provider] === false;

  if (masterOff || providerOff) {
    const what = providerOff && !masterOff && provider
      ? `${keys.label} with ${String(provider).toUpperCase()}`
      : `${keys.label}`;
    return {
      allowed: false,
      reason: `${what} payments are temporarily unavailable while we resolve an issue with our provider. Please try again shortly.`,
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
