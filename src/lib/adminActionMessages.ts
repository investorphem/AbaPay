// ⚡ SHARED (client + server) message builders for admin "step-up" confirmations — a FRESH
// wallet signature required at the moment of a specific high-risk action, on top of the
// standard 12h admin session signature (src/utils/adminAuth.ts). The session signature alone
// just proves "someone with these HTTP headers is calling" — if a session were ever hijacked
// (XSS, a compromised admin browser, a leaked header), the attacker could act for up to 12h
// with no further proof of wallet control. A fresh signature over the SPECIFIC action forces a
// live wallet popup the admin has to see and approve every time — an attacker holding only
// stolen headers, with no live access to the wallet extension, cannot produce one.
//
// Deliberately just pure string-building, no framework/server imports — safe to import from
// both a "use client" component and a server route without pulling anything sensitive along.

export function buildDiscountCreateMessage(params: { name: string; type: string; value: number; timestamp: number }): string {
  return `AbaPay Admin Action: CREATE_DISCOUNT_CAMPAIGN\nName: ${params.name}\nType: ${params.type}\nValue: ${params.value}\nTimestamp: ${params.timestamp}`;
}

/** Switching the NIM discount on or off, or changing its percentage (nim.abapays.com). */
export function buildNimDiscountMessage(params: { enabled: boolean; percent: number; timestamp: number }): string {
  return `AbaPay Admin Action: SET_NIM_DISCOUNT\nEnabled: ${params.enabled ? 'yes' : 'no'}\nPercent: ${params.percent}\nTimestamp: ${params.timestamp}`;
}

/** The outside-agent switches and caps (Admin → Agent → Outside agents, migration 048). Every field is
 * in the message, so the signature covers exactly what is saved. Empty caps read "none". */
export interface AgentPolicyForm {
  agent_ext_max_ngn_per_tx: number | null;
  agent_ext_daily_cap_ngn: number | null;
  verified_agent_discounts_enabled: boolean;
  verified_agent_fee_waiver_enabled: boolean;
  verified_agent_higher_limits_enabled: boolean;
  verified_agent_max_ngn_per_tx: number | null;
  verified_agent_daily_cap_ngn: number | null;
  verified_agent_bank_enabled: boolean;
}

export function buildAgentPolicyMessage(p: AgentPolicyForm & { timestamp: number }): string {
  const v = (n: number | null) => (n === null ? 'none' : String(n));
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return [
    'AbaPay Admin Action: SET_OUTSIDE_AGENT_POLICY',
    `Outside agents max per order: ${v(p.agent_ext_max_ngn_per_tx)}`,
    `Outside agents daily cap: ${v(p.agent_ext_daily_cap_ngn)}`,
    `Verified: discounts ${yn(p.verified_agent_discounts_enabled)}, no facilitator fee ${yn(p.verified_agent_fee_waiver_enabled)}, bank transfers ${yn(p.verified_agent_bank_enabled)}`,
    `Verified higher limits: ${yn(p.verified_agent_higher_limits_enabled)} (max per order ${v(p.verified_agent_max_ngn_per_tx)}, daily cap ${v(p.verified_agent_daily_cap_ngn)})`,
    `Timestamp: ${p.timestamp}`,
  ].join('\n');
}

export const CONFIRM_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — long enough for a slow wallet popup, short enough to make a replayed old signature useless
