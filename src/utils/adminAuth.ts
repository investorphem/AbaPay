import 'server-only';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { verifySiweProof } from '@/utils/walletAuth';

// 🔐 ADMIN SESSIONS (M4.5) — short-lived, revocable, and NOT the vault owner key.
//
// 🔴 WHAT THIS REPLACES. Every admin request used to carry x-admin-address/signature/timestamp:
// a signature over "AbaPay Admin Login: <ts>" from whoever owned the vault contract (with an
// on-chain owner() fallback), valid for 12 hours, bound to no website, impossible to revoke.
// So the most powerful key in the system was also the one signing in to a web dashboard every
// day, and a captured header triple was 12 hours of admin.
//
// NOW:
//   • Admins are an explicit allowlist of OPS wallets (ADMIN_WALLET_ADDRESSES, default below),
//     never the vault owner by fallback. The owner key stays for on-chain vault operations,
//     which the contract itself restricts (refundUser, withdrawals, pause, relayer, tokens).
//   • POST /api/admin/login verifies a Sign-In with Ethereum message (domain-bound, single-use
//     nonce, 5-minute validity; see src/lib/siwe.ts) and issues an opaque 256-bit session id in
//     an HttpOnly, Secure, SameSite=Strict cookie. Only its SHA-256 is stored (migration 033).
//   • A session ends after 2h idle or 8h absolute, or when revoked (sign out / everywhere).
//   • State-changing requests must also carry a same-site Origin header (CSRF, on top of
//     SameSite=Strict).
//
// Every /api/admin/* route keeps calling verifyAdminRequest(req) exactly as before.

export const ADMIN_COOKIE = 'abapay_admin';
export const ADMIN_LOGIN_ACTION = 'POST:/api/admin/login';

// The ops wallet chosen by the owner on 2026-10-01. Deliberately NOT the vault owner
// (0xec24…), so day-to-day admin no longer exercises the key that controls the funds.
const DEFAULT_ADMIN_WALLETS = ['0x36787a2d3d114b35f687d946b9f248e48d37ba5c'];
const IDLE_MS = 2 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

function absoluteTtlMs(): number {
  const minutes = Number(process.env.ADMIN_SESSION_TTL_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) * 60_000 : 8 * 60 * 60 * 1000;
}

let warnedLegacyEnv = false;
export function adminWallets(): string[] {
  if (process.env.ADMIN_WALLET_ADDRESS && !warnedLegacyEnv) {
    warnedLegacyEnv = true;
    console.warn('[adminAuth] ADMIN_WALLET_ADDRESS is no longer read (it often held the vault owner). Admins come from ADMIN_WALLET_ADDRESSES or the built-in ops wallet.');
  }
  const configured = (process.env.ADMIN_WALLET_ADDRESSES || '')
    .split(',').map((a) => a.trim().toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a));
  return configured.length ? configured : DEFAULT_ADMIN_WALLETS;
}

interface AdminSessionRow {
  id_hash: string;
  address: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function clientIp(req: Request): string | null {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || null;
}

/** Same-site check for state-changing requests: the browser's Origin must be this host. */
function originAllowed(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').toLowerCase();
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
}

/**
 * Sign in: verify a SIWE message from an admin wallet and create a session. Returns the raw
 * session token for the cookie (never stored server-side).
 */
export async function createAdminSession(req: Request): Promise<
  { ok: true; token: string; address: string; maxAgeSeconds: number } | { ok: false; status: number; message: string }
> {
  const proof = await verifySiweProof(req, { purpose: 'action', action: ADMIN_LOGIN_ACTION });
  if (!proof) return { ok: false, status: 400, message: 'Sign-in message missing.' };
  if (!proof.ok) return { ok: false, status: 401, message: proof.message };
  const address = proof.address.toLowerCase();
  if (!adminWallets().includes(address)) {
    return { ok: false, status: 403, message: 'This wallet is not an AbaPay admin.' };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = absoluteTtlMs();
  const { error } = await supabaseAdmin.from('admin_sessions').insert({
    id_hash: sha256(token),
    address,
    expires_at: new Date(Date.now() + ttl).toISOString(),
    user_agent: (req.headers.get('user-agent') || '').slice(0, 300) || null,
    ip: clientIp(req),
  });
  if (error) {
    console.error('[adminAuth] session insert failed:', error.message);
    return { ok: false, status: 503, message: 'Could not start an admin session right now.' };
  }
  return { ok: true, token, address, maxAgeSeconds: Math.floor(ttl / 1000) };
}

// 🔐 SERVER-SIDE ADMIN CHECK — used by every /api/admin/* route.
export async function verifyAdminRequest(req: Request): Promise<{ authorized: boolean; message: string; address?: string }> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return { authorized: false, message: 'Unauthorized: sign in to the admin dashboard.' };
  if (!originAllowed(req)) return { authorized: false, message: 'Forbidden: cross-site request.' };

  const { data, error } = await supabaseAdmin
    .from('admin_sessions').select('*').eq('id_hash', sha256(token)).maybeSingle();
  if (error) {
    console.error('[adminAuth] session lookup failed:', error.message);
    return { authorized: false, message: 'Could not verify the admin session right now.' };
  }
  const s = data as AdminSessionRow | null;
  const now = Date.now();
  if (!s || s.revoked_at || new Date(s.expires_at).getTime() <= now || now - new Date(s.last_seen_at).getTime() > IDLE_MS) {
    return { authorized: false, message: 'Unauthorized: admin session expired. Please sign in again.' };
  }
  // An address removed from the allowlist loses its open sessions immediately.
  if (!adminWallets().includes(String(s.address).toLowerCase())) {
    return { authorized: false, message: 'Unauthorized: this wallet is no longer an admin.' };
  }

  if (now - new Date(s.last_seen_at).getTime() > TOUCH_EVERY_MS) {
    await supabaseAdmin.from('admin_sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('id_hash', s.id_hash);
  }
  return { authorized: true, message: 'OK', address: s.address };
}

/** Sign out this session, or (all: true) every open session for the same admin wallet. */
export async function revokeAdminSessions(req: Request, all: boolean): Promise<{ revoked: number }> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return { revoked: 0 };
  const idHash = sha256(token);
  const nowIso = new Date().toISOString();
  if (!all) {
    const { data } = await supabaseAdmin.from('admin_sessions').update({ revoked_at: nowIso }).eq('id_hash', idHash).is('revoked_at', null).select('id_hash');
    return { revoked: (data || []).length };
  }
  const { data: me } = await supabaseAdmin.from('admin_sessions').select('address').eq('id_hash', idHash).maybeSingle();
  if (!me) return { revoked: 0 };
  const { data } = await supabaseAdmin.from('admin_sessions').update({ revoked_at: nowIso }).eq('address', (me as { address: string }).address).is('revoked_at', null).select('id_hash');
  return { revoked: (data || []).length };
}
