import 'server-only'; // SECURITY: Ensures these keys never leak to the frontend

// 🔐 generateRequestId() USED TO LIVE HERE — a second, independent implementation of the same
// CSPRNG request-id generator as getStrictRequestId() in src/lib/vend.ts. It had NO callers
// anywhere in the codebase (every payment path uses getStrictRequestId), so it was dead code
// duplicating a security-critical primitive: the exact shape in which one copy gets hardened
// and the other quietly keeps a Math.random() suffix. The single implementation now lives in
// src/lib/requestId.ts and is re-exported from src/lib/vend.ts.

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