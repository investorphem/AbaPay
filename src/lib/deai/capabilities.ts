import 'server-only';
import { getServiceRules, killSwitchKeysFor, minAmountFor } from '@/lib/serviceRules';
import { maxAmountFor } from '@/lib/parity';
import { verifyAccount, fetchDataVariations, resolveServiceId } from '@/lib/deai/services';
import { resolveCountry, fetchCountries } from '@/lib/deai/international';

// ⚡ CAPABILITY & FEASIBILITY ENGINE
//
// The agent should never blindly attempt something and fail with a shrug. Before it
// promises anything, it consults this module, which answers three questions:
//
//   1. CAN we do this at all?              (is the service supported?)
//   2. Is it possible RIGHT NOW?           (kill switches, limits, verification)
//   3. If not — WHY, and what SHOULD the user do instead?
//
// Every "no" comes with a reason and, wherever possible, a concrete next step. This is the
// difference between an agent that feels broken and one that feels helpful.

export type Capability =
  | 'AIRTIME' | 'DATA' | 'ELECTRICITY' | 'CABLE'
  | 'BANK_TRANSFER' | 'EDUCATION' | 'INTERNATIONAL';

export interface CapabilitySpec {
  id: Capability;
  label: string;
  supportedInChat: boolean;   // can the agent complete this end-to-end in chat?
  needsVerification: boolean; // must we verify the account with VTpass first?
  requires: string[];         // the fields we need from the user
  example: string;
  notes?: string;
}

export const CAPABILITIES: CapabilitySpec[] = [
  {
    id: 'AIRTIME',
    label: 'Airtime top-up',
    supportedInChat: true,
    needsVerification: false,
    requires: ['provider', 'phone number', 'amount'],
    example: 'Send ₦500 airtime to 08012345678',
  },
  {
    id: 'DATA',
    label: 'Data bundles',
    supportedInChat: true,
    needsVerification: false,
    requires: ['provider', 'phone number', 'data plan'],
    example: 'Buy 1GB data for 08012345678',
  },
  {
    id: 'ELECTRICITY',
    label: 'Electricity (prepaid & postpaid)',
    supportedInChat: true,
    needsVerification: true,
    requires: ['disco', 'meter number', 'meter type', 'amount'],
    example: 'Pay ₦2,000 Ikeja electric, meter 04123456789',
  },
  {
    id: 'CABLE',
    label: 'Cable TV (DStv, GOtv, Startimes)',
    supportedInChat: true,
    needsVerification: true,
    requires: ['provider', 'smartcard/IUC number', 'package'],
    example: 'Renew my DStv, smartcard 1234567890',
  },
  {
    id: 'BANK_TRANSFER',
    label: 'Bank transfer',
    supportedInChat: false,
    needsVerification: true,
    requires: ['bank', 'account number', 'amount'],
    example: 'Send ₦5,000 to my GTBank account 0123456789',
    notes: 'Bank transfers move money to a third party and are higher-risk, so they must be confirmed with your own wallet signature in the app — the agent will not execute these from a chat allowance.',
  },
  {
    id: 'EDUCATION',
    // 🔴 WHY THIS FLIPPED TO supportedInChat: true — the old note ("profile code, exam year
    // are easier to get right in the app") described a chat channel that could not list a
    // provider, could not list a product, and could not verify anything. All three exist now
    // and are the SAME machinery cable/data already use in production: providersFor()
    // ('🎓 Which exam body?'), fetchVariations() + the paginated AWAITING_VARIATION picker,
    // and verifyAccount() for the JAMB profile ID. There is no longer any education detail
    // the app can collect that chat cannot. Bank transfer below is a different case and stays
    // app-only — that reasoning is about who signs for third-party money movement, not about
    // which fields are collectable.
    label: 'Education PINs (WAEC, JAMB)',
    supportedInChat: true,
    // Only JAMB verifies (see parity.ts's requiresVerifiedName) — WAEC has no account to
    // verify at all. Callers that need the per-provider rule must use requiresVerifiedName;
    // this flag only says "this capability verifies SOMETHING".
    needsVerification: true,
    requires: ['exam body', 'product/plan', 'phone number', 'JAMB profile ID (JAMB only)'],
    example: 'Buy a WAEC result checker PIN',
  },
  {
    id: 'INTERNATIONAL',
    label: 'International airtime & data',
    supportedInChat: true,
    needsVerification: false,
    requires: ['country', 'phone number', 'amount'],
    example: 'Send airtime to a Ghana number 0244123456',
    notes: 'Available for every country VTpass supports — I check the live list before promising anything.',
  },
];

export function getCapability(id: Capability): CapabilitySpec | undefined {
  return CAPABILITIES.find(c => c.id === id);
}

/** The inverse of capabilityForIntent — each capability's own agent intent. */
const INTENT_FOR_CAPABILITY: Record<Capability, string> = {
  AIRTIME: 'VEND_AIRTIME',
  DATA: 'VEND_DATA',
  ELECTRICITY: 'ELECTRICITY',
  CABLE: 'TV',
  BANK_TRANSFER: 'BANK_TRANSFER',
  EDUCATION: 'EDUCATION',
  INTERNATIONAL: 'INTERNATIONAL',
};

/** Map an agent intent to a capability. */
export function capabilityForIntent(intent: string): Capability | null {
  switch (intent) {
    case 'VEND_AIRTIME': return 'AIRTIME';
    case 'VEND_DATA': return 'DATA';
    case 'PAY_ELECTRICITY':
    case 'ELECTRICITY': return 'ELECTRICITY';
    case 'PAY_CABLE':
    case 'TV': return 'CABLE';
    case 'BANK_TRANSFER': return 'BANK_TRANSFER';
    case 'EDUCATION': return 'EDUCATION';
    case 'INTERNATIONAL': return 'INTERNATIONAL';
    default: return null;
  }
}

export interface Feasibility {
  possible: boolean;
  /** Can it be finished right here in chat, or does it need the app? */
  needsApp: boolean;
  reason?: string;
  /** Concrete next steps the user can actually take. */
  suggestions: string[];
  /** What we still need from them before we can proceed. */
  missing: string[];
  appUrl?: string;
  /**
   * Why a `possible:false` was returned, so the caller can decide whether the block is
   * RECOVERABLE (the user just needs to supply a different value — keep the in-flight
   * session and re-ask) or FATAL (nothing to retry — safe to reset). Only 'AMOUNT_*' are
   * recoverable; everything else means the whole request can't proceed as stated.
   */
  blockCode?: 'AMOUNT_TOO_LOW' | 'AMOUNT_TOO_HIGH' | 'DISABLED' | 'UNSUPPORTED' | 'OTHER';
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';

/**
 * The core question: "can I actually do what this person is asking, right now?"
 *
 * Always returns something ACTIONABLE — never a bare "no".
 */
export async function assessFeasibility(params: {
  intent: string;
  provider?: string | null;
  amountNgn?: number | null;
  account?: string | null;
  meterType?: string | null;
  verifiedMin?: number | null;
  country?: string | null;
}): Promise<Feasibility> {
  const { intent, provider, amountNgn, account, meterType, country } = params;

  // ── INTERNATIONAL: check the LIVE VTpass country list before promising anything.
  // The web app pulls countries live from VTpass, so the agent must too — otherwise it
  // would either refuse countries the app supports, or promise ones that fail at vend time.
  if (intent === 'INTERNATIONAL') {
    // 🔴 This branch returns before the kill-switch check further down, so international was
    // the ONE capability that could be walked all the way through country selection with
    // MASTER_INTERNATIONAL switched off — the help menu already printed it as paused. Refuse
    // up front instead of at the payment gate, after the user has typed a number.
    const intlRules = await getServiceRules();
    if (intlRules.killSwitches.MASTER_INTERNATIONAL === false) {
      return {
        possible: false,
        needsApp: false,
        reason: "International airtime is temporarily unavailable — we've paused it while we sort out an issue with our provider.",
        suggestions: [
          'This usually clears within a few hours.',
          'I can still send airtime, data, electricity or cable inside Nigeria — just say the word.',
        ],
        missing: [],
        blockCode: 'DISABLED',
      };
    }

    if (!country) {
      const list = await fetchCountries();
      const sample = list.slice(0, 8).map(c => c.name).join(', ');
      return {
        possible: true,
        needsApp: false,
        reason: 'Which country are you sending to?',
        suggestions: list.length ? [`I support ${list.length} countries — including ${sample}…`] : ['Let me know the country and number.'],
        missing: ['country'],
      };
    }

    const resolved = await resolveCountry(country);
    if (!resolved) {
      const list = await fetchCountries();
      return {
        possible: false,
        needsApp: false,
        reason: `I can't send airtime to "${country}" — our provider doesn't cover it.`,
        suggestions: [
          list.length ? `I currently support ${list.length} countries. Try another, or say *countries* to see them.` : 'Please try a different country.',
        ],
        missing: [],
      };
    }

    if (!account) {
      return {
        possible: true, needsApp: false,
        reason: `Great — ${resolved.name}. What's the phone number?`,
        suggestions: [], missing: ['account'],
      };
    }
    if (!amountNgn) {
      return {
        possible: true, needsApp: false,
        reason: `How much would you like to send to that ${resolved.name} number?`,
        suggestions: [], missing: ['amount'],
      };
    }

    return { possible: true, needsApp: false, suggestions: [], missing: [] };
  }

  const cap = capabilityForIntent(intent);
  if (!cap) {
    return {
      possible: false,
      needsApp: false,
      reason: "I'm not sure what you'd like to pay for.",
      suggestions: [
        'Try: "Send ₦500 airtime to 08012345678"',
        'Try: "Pay ₦2,000 Ikeja electric, meter 04123456789"',
        'Type *help* to see everything I can do.',
      ],
      missing: [],
    };
  }

  const spec = getCapability(cap)!;

  // ── 1. Is the service switched on? ────────────────────────────────────────
  const rules = await getServiceRules();
  // Two-level, same as the web app and checkServiceAllowed: the whole service can be paused,
  // or just one provider. `provider` may be absent this early in the conversation — then only
  // the master is checked, and the per-provider block lands at the payment gate instead.
  const keys = killSwitchKeysFor(intent, provider);
  const providerOff = !!(keys?.provider && rules.killSwitches[keys.provider] === false);
  if (keys && (rules.killSwitches[keys.master] === false || providerOff)) {
    const what = providerOff && rules.killSwitches[keys.master] !== false && provider
      ? `${spec.label} with ${String(provider).toUpperCase()}`
      : spec.label;
    return {
      possible: false,
      needsApp: false,
      reason: `${what} is temporarily unavailable — we've paused it while we sort out an issue with our provider.`,
      suggestions: [
        'This usually clears within a few hours.',
        'I can help you with another bill in the meantime — just say the word.',
      ],
      missing: [],
      blockCode: 'DISABLED',
    };
  }

  // ── 2. Can it be done in chat, or does it need the app? ───────────────────
  if (!spec.supportedInChat) {
    return {
      possible: true,          // it IS possible — just not from here
      needsApp: true,
      reason: spec.notes || `${spec.label} needs to be completed in the app.`,
      suggestions: [
        `Open AbaPay and choose ${spec.label}: ${APP_URL}`,
        'Everything else — airtime, data, electricity, cable — I can do right here.',
      ],
      missing: [],
      appUrl: APP_URL,
    };
  }

  // ── 3. Do we have everything we need? ─────────────────────────────────────
  const missing: string[] = [];
  if (!provider) missing.push('provider');
  if (!account) missing.push('account');
  if (!amountNgn && cap !== 'DATA') missing.push('amount');
  if (cap === 'ELECTRICITY' && !meterType) missing.push('meter_type');

  if (missing.length) {
    const asks: Record<string, string> = {
      provider: cap === 'ELECTRICITY' ? 'which disco (e.g. Ikeja, Eko, Ibadan)' : 'which network',
      account: cap === 'ELECTRICITY' ? 'your meter number' : cap === 'CABLE' ? 'your smartcard number' : 'the phone number',
      amount: 'how much',
      meter_type: 'prepaid or postpaid',
    };
    return {
      possible: true,
      needsApp: false,
      reason: `I just need ${missing.map(m => asks[m] || m).join(' and ')}.`,
      suggestions: [`For example: "${spec.example}"`],
      missing,
    };
  }

  // ── 4. Does the amount clear the limits? ──────────────────────────────────
  if (amountNgn) {
    // ⚡ Live per-provider limits, same source as the payment gates (see parity.checkAmountLive).
    // 🔴 This pre-flight check runs FIRST, so leaving it on the flat per-intent numbers would
    // have it confidently tell a user "₦120,000 is above the ₦50,000 limit" for an MTN top-up
    // that the actual payment gate — now sourcing MTN's real ₦200,000 ceiling — would allow.
    // The two must agree or the agent contradicts itself between messages.
    let live: { min: number | null; max: number | null } = { min: null, max: null };
    try {
      const { limitsForIntent } = await import('@/lib/vtpassCatalog');
      live = await limitsForIntent(intent, params.provider);
    } catch { /* fall through to the flat limits below */ }

    const min = Math.max(minAmountFor(intent), Number(params.verifiedMin) || 0, Number(live.min) || 0);
    if (amountNgn < min) {
      return {
        possible: false,
        needsApp: false,
        reason: `The minimum for ${spec.label.toLowerCase()} is ₦${min.toLocaleString()} — you asked for ₦${amountNgn.toLocaleString()}.`,
        suggestions: [`Try ₦${min.toLocaleString()} or more.`],
        missing: [],
        blockCode: 'AMOUNT_TOO_LOW',
      };
    }
    // Same ceiling the payment gates use — this check runs FIRST, so hardcoding 500,000 here
    // meant a ₦200,000 airtime request was told it was fine and got the real limit only later,
    // from a different message. Now VTpass's own per-provider ceiling when it publishes one,
    // falling back to the flat per-intent number when it doesn't.
    const max = Number(live.max) > 0 ? Number(live.max) : maxAmountFor(intent);
    if (amountNgn > max) {
      return {
        possible: false,
        needsApp: false,
        reason: `₦${amountNgn.toLocaleString()} is above the ₦${max.toLocaleString()} per-transaction limit.`,
        suggestions: ['Split it into smaller payments, or pay in the app.'],
        missing: [],
        blockCode: 'AMOUNT_TOO_HIGH',
      };
    }
  }

  return { possible: true, needsApp: false, suggestions: [], missing: [] };
}

/**
 * A human-readable capability menu — what the agent tells the user it can do.
 *
 * `channel` matters for the automations section: recurring/one-time schedules are only
 * creatable from chat (Telegram/WhatsApp/X, via natural language) — the MCP tool surface
 * (src/app/api/mcp/route.ts) has no schedule-creation tool at all, only pay_bill/check_balance/
 * list_plans/list_international_options/transaction_history/describe_capabilities. Promising
 * "ask me to set up a recurring automation" to an MCP-connected agent would be a dead end: it
 * has no tool to actually do that.
 */
export async function describeCapabilities(channel: 'CHAT' | 'MCP' = 'CHAT'): Promise<string> {
  const rules = await getServiceRules();

  const lines: string[] = ['*Here\'s what I can do:*', ''];

  const chatable = CAPABILITIES.filter(c => c.supportedInChat);
  const appOnly = CAPABILITIES.filter(c => !c.supportedInChat);

  lines.push('💬 *Right here in chat:*');
  for (const c of chatable) {
    // 🔴 THE BUG THIS FIXES: this was a ternary chain ending in a bare `: 'TV'`, so EVERY
    // in-chat capability that wasn't airtime/data/electricity resolved to the CABLE kill
    // switch — INTERNATIONAL already did, and EDUCATION now would too. Pausing cable would
    // have printed "_(temporarily paused)_" beside international airtime and education PINs,
    // and pausing education would never have shown at all. Each capability maps to its OWN
    // intent, and international has its own master switch (see checkServiceAllowed).
    // This menu is per-SERVICE, so only the MASTER_ level is shown — a single paused disco
    // shouldn't hide "Electricity" from the list. The per-provider switch is enforced at the
    // payment gate, once we know which provider the user actually wants.
    const keys = killSwitchKeysFor(INTENT_FOR_CAPABILITY[c.id]);
    const off = !!(keys && rules.killSwitches[keys.master] === false);
    lines.push(`${off ? '⛔' : '•'} ${c.label}${off ? ' _(temporarily paused)_' : ''}`);
    if (!off) lines.push(`   _"${c.example}"_`);
  }

  lines.push('', '📱 *In the AbaPay app:*');
  for (const c of appOnly) {
    lines.push(`• ${c.label}`);
  }

  // 🔴 THE BUG THIS FIXES: nothing here ever said a ONE-TIME future-dated payment ("send this
  // in 40 minutes") isn't just "paid instantly instead" — an agent reading only recurring
  // examples had no signal that a delay request needs handling before defaulting to instant
  // execution. Confirmed live: real money moved on an explicit "in the next 40 minutes"
  // instruction with no clarifying question asked first. pay_bill itself has no queue/delay
  // parameter — every call executes immediately, on every channel.
  if (channel === 'MCP') {
    lines.push(
      '',
      '⚠️ *Every payment here executes immediately* — there is no tool on this connection to delay, queue, or schedule one. If asked to pay "in 40 minutes" or "tomorrow", don\'t default to paying now: ask the human to confirm paying immediately, or tell them recurring/delayed automations are only settable from the AbaPay app or by messaging the AbaPay agent on Telegram/WhatsApp/X.'
    );
  } else {
    lines.push(
      '',
      '🔁 *Automations (recurring only):*',
      '_"Every Tuesday buy ₦200 airtime for 08012345678"_',
      '_"Pay my meter ₦5,000 on the 28th every month"_',
      '',
      '⚠️ *No one-time delayed payments* — "in 40 minutes" or "tomorrow at 3pm" isn\'t something I can queue on its own. Every payment executes immediately once confirmed. If you want it to happen later, ask me to set up an automation instead (even a "just once" cadence works there) — otherwise I should ask before paying now.',
      '',
      '💳 Say *balance* to see your funds, *history* for past payments, or *schedules* to manage automations.'
    );
  }

  return lines.join('\n');
}
