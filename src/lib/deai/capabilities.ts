import 'server-only';
import { getServiceRules, killSwitchKeyFor, minAmountFor } from '@/lib/serviceRules';
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
    label: 'Education PINs (WAEC, JAMB)',
    supportedInChat: false,
    needsVerification: true,
    requires: ['exam body', 'profile/phone', 'quantity'],
    example: 'Buy a WAEC result checker PIN',
    notes: 'Education PINs need extra details (profile code, exam year) that are easier to get right in the app.',
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
  const key = killSwitchKeyFor(intent);
  if (key && rules.killSwitches[key] === false) {
    return {
      possible: false,
      needsApp: false,
      reason: `${spec.label} is temporarily unavailable — we've paused it while we sort out an issue with our provider.`,
      suggestions: [
        'This usually clears within a few hours.',
        'I can help you with another bill in the meantime — just say the word.',
      ],
      missing: [],
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
    const min = Math.max(minAmountFor(intent), Number(params.verifiedMin) || 0);
    if (amountNgn < min) {
      return {
        possible: false,
        needsApp: false,
        reason: `The minimum for ${spec.label.toLowerCase()} is ₦${min.toLocaleString()} — you asked for ₦${amountNgn.toLocaleString()}.`,
        suggestions: [`Try ₦${min.toLocaleString()} or more.`],
        missing: [],
      };
    }
    if (amountNgn > 500_000) {
      return {
        possible: false,
        needsApp: false,
        reason: `₦${amountNgn.toLocaleString()} is above the ₦500,000 per-transaction limit.`,
        suggestions: ['Split it into smaller payments, or pay in the app.'],
        missing: [],
      };
    }
  }

  return { possible: true, needsApp: false, suggestions: [], missing: [] };
}

/**
 * A human-readable capability menu — what the agent tells the user it can do.
 */
export async function describeCapabilities(): Promise<string> {
  const rules = await getServiceRules();

  const lines: string[] = ['*Here\'s what I can do:*', ''];

  const chatable = CAPABILITIES.filter(c => c.supportedInChat);
  const appOnly = CAPABILITIES.filter(c => !c.supportedInChat);

  lines.push('💬 *Right here in chat:*');
  for (const c of chatable) {
    const key = killSwitchKeyFor(
      c.id === 'AIRTIME' ? 'VEND_AIRTIME' :
      c.id === 'DATA' ? 'VEND_DATA' :
      c.id === 'ELECTRICITY' ? 'ELECTRICITY' : 'TV'
    );
    const off = key && rules.killSwitches[key] === false;
    lines.push(`${off ? '⛔' : '•'} ${c.label}${off ? ' _(temporarily paused)_' : ''}`);
    if (!off) lines.push(`   _"${c.example}"_`);
  }

  lines.push('', '📱 *In the AbaPay app:*');
  for (const c of appOnly) {
    lines.push(`• ${c.label}`);
  }

  lines.push(
    '',
    '🔁 *Automations:*',
    '_"Every Tuesday buy ₦200 airtime for 08012345678"_',
    '_"Pay my meter ₦5,000 on the 28th every month"_',
    '',
    '💳 Say *balance* to see your funds, *history* for past payments, or *schedules* to manage automations.'
  );

  return lines.join('\n');
}
