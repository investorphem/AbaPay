import 'server-only';
import crypto from 'crypto';

// ⚡ DeAI DEEP-LINK HAND-OFF
//
// THE PROBLEM THIS SOLVES:
// AbaPay's contract uses `transferFrom(msg.sender, ...)`, so the PAYER MUST BE THE SIGNER.
// On Telegram/WhatsApp/X there is no wallet to sign with, and there is no server-side key
// that could sign on the user's behalf (there must never be one — that would make AbaPay a
// custodian of user funds).
//
// So the agent does everything EXCEPT hold the keys: it understands the request, verifies
// the meter/account against real VTpass, confirms the details in chat, and then hands the
// user a one-tap link that opens the app with the payment pre-filled. The user signs with
// their OWN wallet. Fully non-custodial, no contract change required.
//
// WHY THE LINK IS SIGNED:
// - Integrity: nobody can hand a user a doctored AbaPay link with different details.
// - Expiry: a stale link can't be replayed days later at a different exchange rate.
// The signature is HMAC-SHA256 over the payload using a server-only secret.

const TTL_SECONDS = 15 * 60; // links are valid for 15 minutes

export interface DeepLinkIntent {
  serviceID: string;              // vtpass service id, e.g. "mtn" | "ikeja-electric"
  serviceCategory: string;        // "AIRTIME" | "DATA" | "ELECTRICITY" | "CABLE"
  provider: string;               // display name
  billersCode: string;            // phone / meter / smartcard
  amountNgn: number;
  variationCode?: string;         // data plan / cable package
  meterType?: string;             // prepaid | postpaid
  cableAction?: string;           // renew | change (DStv/GOtv)
  customerName?: string;          // from VTpass verification
  customerAddress?: string;
  // ⚡ CHAIN SELECTION: without this the app just used whatever chain the wallet happened to
  // be on, so an agent-originated payment could land on the wrong chain (wrong token set,
  // and — for the Celo hackathon — no attribution credit). Defaults to CELO.
  chain?: 'CELO' | 'BASE';
  token?: string;                 // e.g. "USD₮" | "cUSD" | "USDC"
  channel: string;                // TELEGRAM | WHATSAPP | X
  chatId: string;                 // so we can send the receipt back to the right chat
  iat: number;                    // issued-at (unix seconds)
}

function secret(): string {
  const s = process.env.DEAI_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('No secret material available for deep-link signing.');
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * Build a signed, expiring deep link that opens the app with this payment pre-filled.
 */
export function createDeepLink(baseUrl: string, intent: Omit<DeepLinkIntent, 'iat'>): string {
  const full: DeepLinkIntent = { ...intent, iat: Math.floor(Date.now() / 1000) };
  const payload = b64url(JSON.stringify(full));
  const sig = sign(payload);
  return `${baseUrl.replace(/\/$/, '')}/?pay=${payload}&sig=${sig}`;
}

export interface VerifyResult {
  valid: boolean;
  intent?: DeepLinkIntent;
  reason?: string;
}

/**
 * Verify + decode a deep link payload. Rejects tampering and expiry.
 */
export function verifyDeepLink(payload: string, sig: string): VerifyResult {
  try {
    if (!payload || !sig) return { valid: false, reason: 'Missing payload or signature' };

    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature mismatch — this link was tampered with.' };
    }

    const intent: DeepLinkIntent = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    const age = Math.floor(Date.now() / 1000) - (intent.iat || 0);
    if (age > TTL_SECONDS) {
      return { valid: false, reason: 'This payment link has expired. Ask the agent for a new one.' };
    }
    if (age < -60) {
      return { valid: false, reason: 'Invalid link timestamp.' };
    }

    return { valid: true, intent };
  } catch (err) {
    return { valid: false, reason: 'Malformed payment link.' };
  }
}
