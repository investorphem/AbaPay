import 'server-only'; // SECURITY: Ensures these keys never leak to the frontend
import crypto from 'crypto';

/**
 * 1. COMPLIANT ID GENERATOR
 * Rule: VTpass requires the first 12 chars to be YYYYMMDDHHmm (Africa/Lagos),
 *       followed by alphanumeric characters.
 *
 * 🔐 SECURITY: The suffix MUST be cryptographically random.
 *
 * It previously used `Math.random().toString(36).substring(2, 10)`. Math.random() is NOT
 * a CSPRNG — V8's xorshift128+ state can be recovered from a handful of observed outputs,
 * making future IDs predictable. Combined with the fully-predictable timestamp prefix,
 * that made request_ids guessable.
 *
 * That mattered because request_id is the key used to look up a transaction's
 * `purchased_code` (the electricity meter token / WAEC PIN) — a bearer secret worth real
 * money. A predictable ID meant a guessable path to another customer's token.
 *
 * We now use crypto.randomInt() (a CSPRNG, and unbiased — unlike `byte % 36`, which
 * skews toward low values) over a 36-char alphabet, with a 12-char suffix:
 * 36^12 ≈ 4.7e18 possibilities, which is not brute-forceable.
 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const generateRequestId = () => {
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Lagos"}));

  const dateStr = now.getFullYear() + 
    String(now.getMonth() + 1).padStart(2, '0') + 
    String(now.getDate()).padStart(2, '0') + 
    String(now.getHours()).padStart(2, '0') + 
    String(now.getMinutes()).padStart(2, '0');

  // 12 numeric (VTpass-mandated date prefix) + 12 cryptographically random alphanumeric.
  let randomSuffix = '';
  for (let i = 0; i < 12; i++) {
    randomSuffix += ID_ALPHABET[crypto.randomInt(0, ID_ALPHABET.length)];
  }

  return `${dateStr}${randomSuffix}`;
};

/**
 * 2. DYNAMIC AUTH HEADERS (LIVE API KEYS)
 * Upgraded to VTpass Live B2B Auth using API, Public, and Secret keys.
 * Ensure VTPASS_API_KEY, VTPASS_PUBLIC_KEY, and VTPASS_SECRET_KEY are set securely in Vercel.
 */
export const getHeaders = () => {
  return {
    'api-key': process.env.VTPASS_API_KEY || '',
    'public-key': process.env.VTPASS_PUBLIC_KEY || '',
    'secret-key': process.env.VTPASS_SECRET_KEY || '',
    'Content-Type': 'application/json'
  };
};