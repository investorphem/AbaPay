import crypto from 'crypto';

// 🔐 INTERNAL SERVICE-TO-SERVICE AUTH
//
// Some API routes (like /api/deai/core) are internal "brains" that must only be
// callable by our own webhook routes (Telegram/WhatsApp/X) — never directly from
// the public internet. Without this, anyone who knows a victim's chat ID / phone
// number / X ID could impersonate them: read their balances and history, and
// brute-force their PIN.
//
// The token is a SHA-256 digest of a server-only secret, so the raw secret is
// never transmitted. Uses DEAI_INTERNAL_SECRET when set, otherwise derives from
// SUPABASE_SERVICE_ROLE_KEY (always present server-side) so this works with zero
// new configuration.

const INTERNAL_HEADER = 'x-abapay-internal';

function getSecretMaterial(): string | null {
  return process.env.DEAI_INTERNAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

export function getInternalToken(): string | null {
  const material = getSecretMaterial();
  if (!material) return null;
  return crypto.createHash('sha256').update(`abapay-internal:${material}`).digest('hex');
}

export function internalAuthHeaders(): Record<string, string> {
  const token = getInternalToken();
  return token ? { [INTERNAL_HEADER]: token } : {};
}

export function verifyInternalRequest(req: Request): boolean {
  const expected = getInternalToken();
  if (!expected) {
    // No secret material configured at all — fail closed rather than open.
    console.error('[SECURITY] Internal auth secret material missing (set DEAI_INTERNAL_SECRET or SUPABASE_SERVICE_ROLE_KEY).');
    return false;
  }
  const provided = req.headers.get(INTERNAL_HEADER);
  if (!provided || provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}
