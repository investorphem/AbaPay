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

export const CONFIRM_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — long enough for a slow wallet popup, short enough to make a replayed old signature useless
