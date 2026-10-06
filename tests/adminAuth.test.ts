import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// M4.5: admin access is a revocable, short-lived cookie session for an allowlisted OPS wallet,
// signed in once with SIWE, never the vault owner by fallback.

let db: FakeDb;
vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/chain', () => ({ getPublicClient: () => { throw new Error('no RPC in tests'); } }));

import { verifyAdminRequest, adminWallets, ADMIN_COOKIE } from '@/utils/adminAuth';
import { buildSiweMessage, encodeSiweHeader } from '@/lib/siwe';
import { POST as loginPOST } from '@/app/api/admin/login/route';
import { POST as logoutPOST } from '@/app/api/admin/logout/route';

const ops = privateKeyToAccount(('0x' + '51'.repeat(32)) as `0x${string}`);
const owner = privateKeyToAccount(('0x' + '52'.repeat(32)) as `0x${string}`);
const HOST = 'abapays.com';

beforeEach(() => {
  process.env.ADMIN_WALLET_ADDRESSES = ops.address;
  db = createFakeDb({ auth_nonces: [], admin_sessions: [] });
  db.rpcHandlers = {
    consume_auth_nonce: ({ p_nonce, p_purpose }) => {
      const row = db.tables.auth_nonces.find((r) => r.nonce === p_nonce && r.purpose === p_purpose);
      if (!row || Number(row.uses_remaining) <= 0) return false;
      row.uses_remaining = Number(row.uses_remaining) - 1;
      return true;
    },
  };
});
afterEach(() => { delete process.env.ADMIN_WALLET_ADDRESSES; });

let n = 0;
async function login(signer = ops) {
  const nonce = `adminnonce${++n}abc`;
  db.tables.auth_nonces.push({ nonce, purpose: 'action', uses_remaining: 1, expires_at: new Date(Date.now() + 600_000).toISOString() });
  const message = buildSiweMessage({ purpose: 'action', action: 'POST:/api/admin/login', address: signer.address, chainId: 42220, nonce, domain: HOST, uri: `https://${HOST}` });
  const signature = await signer.signMessage({ message });
  return loginPOST(new Request(`https://${HOST}/api/admin/login`, {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, 'x-wallet-signature': signature, 'x-wallet-siwe': encodeSiweHeader(message) },
  }));
}

function cookieFrom(res: Response): string {
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(new RegExp(`${ADMIN_COOKIE}=([^;]+)`));
  return m ? m[1] : '';
}

const adminReq = (token: string, method = 'GET', origin: string | null = `https://${HOST}`) => new Request(`https://${HOST}/api/admin/data`, {
  method,
  headers: { host: HOST, cookie: `${ADMIN_COOKIE}=${token}`, ...(origin ? { origin } : {}) },
});

describe('admin sessions', () => {
  it('an ops wallet signs in and gets an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const token = cookieFrom(res);
    expect(token.length).toBeGreaterThan(30);
    // Only the hash is stored, never the token.
    expect(JSON.stringify(db.tables.admin_sessions)).not.toContain(token);
    expect(await verifyAdminRequest(adminReq(token))).toMatchObject({ authorized: true, address: ops.address.toLowerCase() });
  });

  it('the vault owner (or any non-admin wallet) is refused', async () => {
    const res = await login(owner);
    expect(res.status).toBe(403);
    expect(cookieFrom(res)).toBe('');
  });

  it('the old header triple no longer grants anything', async () => {
    const req = new Request(`https://${HOST}/api/admin/data`, { headers: { 'x-admin-address': ops.address, 'x-admin-signature': '0x00', 'x-admin-timestamp': String(Date.now()) } });
    expect((await verifyAdminRequest(req)).authorized).toBe(false);
  });

  it('refuses a cross-site state-changing request, allows a same-site one', async () => {
    const token = cookieFrom(await login());
    expect((await verifyAdminRequest(adminReq(token, 'POST', 'https://evil.example'))).authorized).toBe(false);
    expect((await verifyAdminRequest(adminReq(token, 'POST', null))).authorized).toBe(false);
    expect((await verifyAdminRequest(adminReq(token, 'POST'))).authorized).toBe(true);
  });

  it('expires after its absolute lifetime and after 2h idle', async () => {
    const token = cookieFrom(await login());
    const row = db.tables.admin_sessions[0];
    row.last_seen_at = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect((await verifyAdminRequest(adminReq(token))).authorized).toBe(false);
    row.last_seen_at = new Date().toISOString();
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await verifyAdminRequest(adminReq(token))).authorized).toBe(false);
  });

  it('sign out revokes the session; sign out everywhere revokes all of that wallet\'s sessions', async () => {
    const a = cookieFrom(await login());
    const b = cookieFrom(await login());
    const out = (token: string, all: boolean) => logoutPOST(new Request(`https://${HOST}/api/admin/logout`, {
      method: 'POST',
      headers: { host: HOST, origin: `https://${HOST}`, cookie: `${ADMIN_COOKIE}=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ all }),
    }));
    await out(a, false);
    expect((await verifyAdminRequest(adminReq(a))).authorized).toBe(false);
    expect((await verifyAdminRequest(adminReq(b))).authorized).toBe(true);
    const c = cookieFrom(await login());
    await out(c, true);
    expect((await verifyAdminRequest(adminReq(b))).authorized).toBe(false);
    expect((await verifyAdminRequest(adminReq(c))).authorized).toBe(false);
  });

  it('removing a wallet from the allowlist ends its open sessions', async () => {
    const token = cookieFrom(await login());
    process.env.ADMIN_WALLET_ADDRESSES = owner.address;
    expect((await verifyAdminRequest(adminReq(token))).authorized).toBe(false);
  });

  it('defaults to the ops wallet, never the vault owner', () => {
    delete process.env.ADMIN_WALLET_ADDRESSES;
    expect(adminWallets()).toEqual(['0x36787a2d3d114b35f687d946b9f248e48d37ba5c']);
    expect(adminWallets()).not.toContain('0xec24bafbc989a9be5f6f0ead8848753b5e4ae0b6');
  });
});
