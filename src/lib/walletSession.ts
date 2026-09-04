// 🔐 THE WALLET-OWNERSHIP MESSAGE — ONE DEFINITION, BOTH SIDES
//
// The browser signs this string and the server rebuilds it to verify the signature. If the two
// ever differ by so much as a space, every signature fails verification — and it fails as
// "invalid signature", which reads like a wallet problem rather than a text mismatch. So it
// lives here, in a module with no `server-only` marker, imported by the page AND by
// src/utils/walletAuth.ts, instead of being written out twice.
//
// Nothing secret is in here by design: the message is shown to the user in their wallet and the
// verification is done by cryptography, not by the string being private.

/**
 * How long a proof of ownership stays good.
 *
 * ⚠️ For its lifetime this is effectively a bearer token — whoever holds the signature can replay
 * it to read that wallet's history. Twelve hours is chosen against the alternative, which is a
 * wallet popup every time the History tab refreshes; that trains people to sign whatever they
 * are shown, which is the habit phishing depends on. It is acceptable ONLY because the scope is
 * read-only and limited to records the wallet's owner can already see. Mutations must never
 * accept it — they keep their own five-minute, per-action signatures.
 */
export const WALLET_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * The message a user signs to prove they hold the wallet they are claiming.
 *
 * Worded for the person reading it in their wallet rather than for us: it says plainly what it
 * proves and, just as importantly, what it does not do. A verification request that looks like a
 * payment is exactly how people learn to click through them without reading.
 *
 * Deliberately different in shape from walletAuthMessage() in src/utils/walletAuth.ts, so a
 * signature collected for one purpose can never satisfy the other.
 */
export function walletSessionMessage(timestamp: string): string {
  return [
    'AbaPay: Secure Sign-In',
    '',
    'Signing this proves you control this wallet and starts a secure, read-only session.',
    'It does NOT approve any payment, transfer, or spending permission.',
    '',
    `Time: ${timestamp}`,
  ].join('\n');
}
