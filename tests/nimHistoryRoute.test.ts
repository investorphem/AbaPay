import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// The NIM History tab lists every order of the signed-in wallet — including ones still waiting
// for their NIM (Nimiq Pay can hold a send as "pending") and expired ones — without exposing the
// internal order placeholder, and never another wallet's orders.

vi.mock('server-only', () => ({}));
let db: FakeDb;
let sessionAddress: string | null = 'NQ6568XN4V9C3BP6S1N9HJBA8XP30LQDJRVX';
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/nimiqAuth', () => ({
  verifyNimSession: () => (sessionAddress ? { ok: true, address: sessionAddress } : { ok: false, message: 'Bad signature.' }),
}));

const { POST } = await import('@/app/api/pay/nim/history/route');
const ME = 'NQ6568XN4V9C3BP6S1N9HJBA8XP30LQDJRVX';
const PAID = 'c'.repeat(64);
const order = (over: Record<string, unknown>) => ({ blockchain: 'NIMIQ', wallet_address: ME, created_at: new Date().toISOString(), amount_naira: 100, ...over });
const load = async () => {
  const res = await POST(new Request('http://localhost/api/pay/nim/history', { method: 'POST', body: JSON.stringify({ message: 'm', signature: 's', publicKey: 'p' }) }));
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  sessionAddress = ME;
  db = createFakeDb({ transactions: [
    order({ id: 'awaiting', status: 'PENDING', tx_hash: 'preflight_nim_106717e7' }),
    order({ id: 'expired', status: 'EXPIRED', error_code: 'PREFLIGHT_UNCONFIRMED', tx_hash: 'preflight_nim_9fa89db7' }),
    order({ id: 'late', status: 'EXPIRED', error_code: 'NIM_LATE_PAYMENT', tx_hash: 'preflight_nim_b188ade4' }),
    order({ id: 'paid', status: 'SUCCESS', tx_hash: PAID }),
    order({ id: 'theirs', status: 'SUCCESS', tx_hash: 'd'.repeat(64), wallet_address: 'NQ16OTHER' }),
    order({ id: 'stable', status: 'SUCCESS', tx_hash: `0x${'e'.repeat(64)}`, blockchain: 'CELO' }),
  ] });
});

describe('/api/pay/nim/history', () => {
  it('lists awaiting-payment and expired orders too, so the customer can see what is going on', async () => {
    const r = await load();
    expect(r.status).toBe(200);
    expect(r.json.transactions.map((t: { status: string; error_code?: string }) => `${t.status}:${t.error_code ?? ''}`).sort()).toEqual(
      ['EXPIRED:NIM_LATE_PAYMENT', 'EXPIRED:PREFLIGHT_UNCONFIRMED', 'PENDING:', 'SUCCESS:'].sort(),
    );
  });

  it('never returns the internal order placeholder as a payment hash', async () => {
    const { json } = await load();
    const hashes = json.transactions.map((t: { tx_hash: string | null }) => t.tx_hash);
    expect(hashes.filter((h: string | null) => h && h.startsWith('preflight_'))).toEqual([]);
    expect(hashes).toContain(PAID);
    expect(hashes.filter((h: string | null) => h === null)).toHaveLength(3);
  });

  it("only ever shows the signed-in wallet's NIM orders", async () => {
    const { json } = await load();
    expect(json.transactions.every((t: { tx_hash: string | null }) => t.tx_hash !== 'd'.repeat(64) && !String(t.tx_hash).startsWith('0x'))).toBe(true);
  });

  it('refuses without a valid signature', async () => {
    sessionAddress = null;
    expect((await load()).status).toBe(401);
  });
});
