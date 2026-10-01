import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// M4.4: wallet-ownership proofs are Sign-In with Ethereum messages, checked for domain, expiry,
// action, signer, and a single-use nonce. The legacy bare-string format works only until the
// cut-off.

let db: FakeDb;
vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
// EOA signatures verify locally; the on-chain (smart wallet) fallback is never reached here.
vi.mock('@/lib/chain', () => ({ getPublicClient: () => { throw new Error('no RPC in tests'); } }));

import { verifyWalletOwnership, verifyWalletSession, legacySignaturesAccepted } from '@/utils/walletAuth';
import { buildSiweMessage, encodeSiweHeader } from '@/lib/siwe';
import { GET as nonceGET } from '@/app/api/auth/nonce/route';

const account = privateKeyToAccount(('0x' + '42'.repeat(32)) as `0x${string}`);
const other = privateKeyToAccount(('0x' + '43'.repeat(32)) as `0x${string}`);
const ACTION = 'POST:/api/agent/link';

beforeEach(() => {
  db = createFakeDb({ auth_nonces: [] });
  db.unique.auth_nonces = ['nonce'];
  // JS model of consume_auth_nonce (migration 032).
  db.rpcHandlers = {
    consume_auth_nonce: ({ p_nonce, p_purpose }) => {
      const row = db.tables.auth_nonces.find((r) => r.nonce === p_nonce && r.purpose === p_purpose);
      if (!row || new Date(row.expires_at).getTime() <= Date.now() || row.uses_remaining <= 0) return false;
      if (row.purpose === 'action') row.uses_remaining -= 1;
      return true;
    },
  };
});
afterEach(() => { delete process.env.LEGACY_WALLET_SIG_ACCEPT_UNTIL; });

async function issueNonce(purpose: 'action' | 'session', uses?: number) {
  const q = new URLSearchParams({ purpose, ...(uses ? { uses: String(uses) } : {}) });
  const res = await nonceGET(new Request(`https://abapays.com/api/auth/nonce?${q}`));
  return (await res.json()).nonce as string;
}

async function proof(opts: {
  purpose?: 'action' | 'session'; action?: string; nonce: string; signer?: typeof account;
  domain?: string; now?: Date; tamper?: (m: string) => string;
}) {
  const signer = opts.signer ?? account;
  let message = buildSiweMessage({
    purpose: opts.purpose ?? 'action', action: opts.action ?? ACTION, address: signer.address,
    chainId: 42220, nonce: opts.nonce, domain: opts.domain ?? 'abapays.com', uri: `https://${opts.domain ?? 'abapays.com'}`, now: opts.now,
  });
  const signature = await signer.signMessage({ message });
  if (opts.tamper) message = opts.tamper(message);
  return new Request('https://abapays.com/x', {
    headers: { 'x-wallet-address': signer.address, 'x-wallet-signature': signature, 'x-wallet-siwe': encodeSiweHeader(message) },
  });
}

describe('SIWE action proofs', () => {
  it('accepts a valid proof once, then refuses the replay', async () => {
    const nonce = await issueNonce('action');
    const req = await proof({ nonce });
    expect(await verifyWalletOwnership(req, account.address, ACTION)).toEqual({ ok: true });
    const replay = await verifyWalletOwnership(await proof({ nonce }), account.address, ACTION);
    expect(replay.ok).toBe(false);
    expect(replay.message).toMatch(/already used/);
  });

  it('refuses a proof made for another website', async () => {
    const r = await verifyWalletOwnership(await proof({ nonce: await issueNonce('action'), domain: 'evil.example' }), account.address, ACTION);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/different website/);
  });

  it('refuses a proof made for a different action', async () => {
    const r = await verifyWalletOwnership(await proof({ nonce: await issueNonce('action'), action: 'DELETE:/api/agent/link' }), account.address, ACTION);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/different action/);
  });

  it('refuses a proof for a different wallet than the one claimed', async () => {
    const r = await verifyWalletOwnership(await proof({ nonce: await issueNonce('action'), signer: other }), account.address, ACTION);
    expect(r.ok).toBe(false);
  });

  it('refuses an expired proof', async () => {
    const r = await verifyWalletOwnership(await proof({ nonce: await issueNonce('action'), now: new Date(Date.now() - 10 * 60_000) }), account.address, ACTION);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/expired/);
  });

  it('refuses a message altered after signing', async () => {
    const r = await verifyWalletOwnership(
      await proof({ nonce: await issueNonce('action'), tamper: (m) => m.replace('Chain ID: 42220', 'Chain ID: 8453') }),
      account.address, ACTION,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Invalid signature/);
  });

  it('refuses a nonce the server never issued', async () => {
    const r = await verifyWalletOwnership(await proof({ nonce: 'madeupnonce123' }), account.address, ACTION);
    expect(r.ok).toBe(false);
  });

  it('a batch nonce covers exactly N requests', async () => {
    const nonce = await issueNonce('action', 2);
    const req = await proof({ action: 'POST:/api/schedules', nonce });
    const again = () => verifyWalletOwnership(req.clone(), account.address, 'POST:/api/schedules');
    expect((await again()).ok).toBe(true);
    expect((await again()).ok).toBe(true);
    expect((await again()).ok).toBe(false);
  });
});

describe('SIWE sessions', () => {
  it('a session proof is reusable and returns the signer', async () => {
    const req = await proof({ purpose: 'session', nonce: await issueNonce('session') });
    expect(await verifyWalletSession(req.clone())).toEqual({ ok: true, address: account.address });
    expect(await verifyWalletSession(req.clone())).toEqual({ ok: true, address: account.address });
  });

  it('an action nonce cannot be passed off as a session', async () => {
    const r = await verifyWalletSession(await proof({ purpose: 'session', nonce: await issueNonce('action') }));
    expect(r.ok).toBe(false);
  });
});

describe('legacy format cut-off', () => {
  async function legacyRequest() {
    const timestamp = String(Date.now());
    const signature = await account.signMessage({ message: `AbaPay Agent Action: ${ACTION}: ${timestamp}` });
    return new Request('https://abapays.com/x', { headers: { 'x-wallet-signature': signature, 'x-wallet-timestamp': timestamp } });
  }

  it('is accepted before the cut-off', async () => {
    process.env.LEGACY_WALLET_SIG_ACCEPT_UNTIL = new Date(Date.now() + 86_400_000).toISOString();
    expect(await verifyWalletOwnership(await legacyRequest(), account.address, ACTION)).toEqual({ ok: true });
  });

  it('is refused after it', async () => {
    process.env.LEGACY_WALLET_SIG_ACCEPT_UNTIL = new Date(Date.now() - 1000).toISOString();
    const r = await verifyWalletOwnership(await legacyRequest(), account.address, ACTION);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no longer accepted/);
  });

  it('defaults to 2026-10-31', () => {
    expect(legacySignaturesAccepted(Date.parse('2026-10-30T23:59:00Z'))).toBe(true);
    expect(legacySignaturesAccepted(Date.parse('2026-10-31T00:00:01Z'))).toBe(false);
  });
});

describe('GET /api/auth/nonce', () => {
  it('issues single-use action nonces, capped batch nonces, and session nonces', async () => {
    await issueNonce('action');
    await issueNonce('action', 500);
    await issueNonce('session');
    const [a, b, s] = db.tables.auth_nonces;
    expect(a).toMatchObject({ purpose: 'action', uses_remaining: 1 });
    expect(b).toMatchObject({ purpose: 'action', uses_remaining: 20 });
    expect(s).toMatchObject({ purpose: 'session', uses_remaining: 1 });
    expect(new Date(s.expires_at).getTime() - Date.now()).toBeGreaterThan(12 * 3600_000);
  });
});
