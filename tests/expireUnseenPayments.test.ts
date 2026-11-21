import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Celo/Base orders still PENDING long after any real transaction would have mined, whose hash the
// chain has never seen (no receipt, not pending), are closed as EXPIRED (src/lib/expireUnseenPayments.ts).
// 2026-11-16: a prober recorded a made-up 0xdede… hash on a Base order.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
const alerts: string[] = [];
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (t: string) => { alerts.push(t); } }));

const notFound = (what: string) => Object.assign(new Error(`${what} could not be found`), { name: `${what}NotFoundError` });
/** State of each hash on the order's own chain (BASE in these tests). */
let chain: Record<string, 'mined' | 'pending' | 'absent' | 'rpc_down'> = {};
/** A hash that exists only on this chain. */
let seenOn: Record<string, string> = {};
const stateOn = (b: string, hash: string) => seenOn[hash] ? (seenOn[hash] === b ? 'mined' : 'absent') : b === 'BASE' ? chain[hash] ?? 'absent' : 'absent';
vi.mock('@/lib/chain', () => ({
  getPublicClient: (b: string) => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const s = stateOn(b, hash);
      if (s === 'mined') return { status: 'success' };
      if (s === 'rpc_down') throw new Error('fetch failed');
      throw notFound('TransactionReceipt');
    },
    getTransaction: async ({ hash }: { hash: string }) => {
      if (stateOn(b, hash) === 'pending') return { hash };
      throw notFound('Transaction');
    },
  }),
}));

const { expireUnseenPayments } = await import('@/lib/expireUnseenPayments');

const NOW = Date.parse('2026-11-16T12:00:00Z');
const h = (c: string) => '0x' + c.repeat(64);
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'PENDING', blockchain: 'BASE', tx_hash: h('d'), created_at: '2026-11-16T00:23:34Z',
  amount_usdt: 0.08, token_used: 'USDC', wallet_address: '0x633dba1a394239a0bfb343b902f98e172c9b3cf2', ...over,
});

beforeEach(() => { chain = {}; seenOn = {}; alerts.length = 0; });

describe('expireUnseenPayments', () => {
  it('closes a PENDING order whose hash the chain never saw, and says so once', async () => {
    db = createFakeDb({ transactions: [row('fake')] });
    chain[h('d')] = 'absent';
    const r = await expireUnseenPayments({ now: NOW });
    expect(r).toMatchObject({ ok: true, expired: 1 });
    expect(db.tables.transactions[0]).toMatchObject({ status: 'EXPIRED', error_code: 'TX_NOT_ON_CHAIN' });
    expect(alerts).toHaveLength(1);
  });

  it('leaves alone a mined tx, one still in the mempool, and one it could not check', async () => {
    db = createFakeDb({ transactions: [row('mined', { tx_hash: h('a') }), row('pending', { tx_hash: h('b') }), row('down', { tx_hash: h('c') })] });
    chain = { [h('a')]: 'mined', [h('b')]: 'pending', [h('c')]: 'rpc_down' };
    const r = await expireUnseenPayments({ now: NOW });
    expect(r.expired).toBe(0);
    expect(db.tables.transactions.every((t) => t.status === 'PENDING')).toBe(true);
    expect(alerts).toEqual([]);
  });

  it('leaves open (and flags) an order whose hash is on the OTHER chain — saved under the wrong chain, not fake', async () => {
    db = createFakeDb({ transactions: [row('misfiled', { tx_hash: h('e') })] });
    seenOn = { [h('e')]: 'CELO' };
    const r = await expireUnseenPayments({ now: NOW });
    expect(r).toMatchObject({ expired: 0, misfiled: 1 });
    expect(db.tables.transactions[0].status).toBe('PENDING');
    expect(alerts[0]).toMatch(/WRONG CHAIN/);
  });

  it('never touches a young order, a PROCESSING one, a placeholder, or a NIM order', async () => {
    db = createFakeDb({ transactions: [
      row('young', { created_at: '2026-11-16T09:00:00Z' }),
      row('processing', { status: 'PROCESSING' }),
      row('placeholder', { tx_hash: 'preflight_5b4f0c38' }),
      row('nim', { blockchain: 'NIMIQ', tx_hash: 'cd'.repeat(32) }),
    ] });
    chain[h('d')] = 'absent';
    const r = await expireUnseenPayments({ now: NOW });
    expect(r.expired).toBe(0);
    expect(db.tables.transactions.map((t) => t.status)).toEqual(['PENDING', 'PROCESSING', 'PENDING', 'PENDING']);
  });
});
