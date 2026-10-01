// 🔐 REDACTION FOR ANYTHING LEAVING THE SERVER LOG (M5).
//
// Telegram alerts (and, as M5 lands, structured logs) are read by more people and kept longer
// than the access-controlled server log. Some values must never reach them:
//   • a full EIP-3009 signature: next to its authorization's fields (value, window, nonce) it IS
//     a usable payment authorization; anyone reading the chat could submit it before it expires;
//   • API keys, PINs, OTPs, private keys, X-PAYMENT headers.
// These helpers keep enough to match an alert against the server log, never the value itself.

/** A signature or other long secret as it may appear in an alert: first 10 + last 6 chars. */
export function sigFingerprint(sig: string | null | undefined): string {
  const s = String(sig || '');
  if (!s) return 'n/a';
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : '[redacted]';
}
