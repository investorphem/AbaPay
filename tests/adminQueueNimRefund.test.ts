import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Admin → Ledger → Refund on a NIM order queues it into Ops → Refunds (POST /api/admin/refunds
// { action: 'QUEUE_NIM' }), so a stuck NIM order the system never queued has somewhere to record
// the treasury's refund. Only a PAID, undelivered, not-yet-queued NIM order qualifies.

vi.mock('server-only', () => ({}));

let db: FakeDb;
let authorized = true;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/utils/adminAuth', () => ({ verifyAdminRequest: async () => ({ authorized, address: '0xadmin' }) }));
vi.mock('@/lib/refundVerify', () => ({ verifyRefundOnChain: async () => ({}), completeRefund: async () => ({}), rememberRefundHash: async () => {}, refundHashAlreadyUsed: async () => false }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {}, sendTelegramToUser: async () => {} }));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));

const { POST } = await import('@/app/api/admin/refunds/route');

const NIM_HASH = 'a'.repeat(64);
const nimRow = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1', blockchain: 'NIMIQ', tx_hash: NIM_HASH, status: 'PROCESSING', wallet_address: 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG',
  amount_usdt: 680, amount_naira: 200, service_category: 'AIRTIME', source_channel: 'NIMIQ', ...over,
});
const queue = async (transaction_id = 'tx-1') => {
  const res = await POST(new Request('http://localhost/api/admin/refunds', { method: 'POST', body: JSON.stringify({ action: 'QUEUE_NIM', transaction_id }) }));
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  db = createFakeDb();
  authorized = true;
});

describe('queue a NIM refund from the ledger', () => {
  it('puts a paid, undelivered NIM order on the Ops refund list', async () => {
    db.tables.transactions = [nimRow()];
    const r = await queue();
    expect(r.json.success).toBe(true);
    expect(db.tables.refund_queue).toEqual([expect.objectContaining({
      transaction_id: 'tx-1', tx_hash: NIM_HASH, token_used: 'NIM', amount_crypto: 680, blockchain: 'NIMIQ', status: 'PENDING',
    })]);
  });

  it('never queues it twice', async () => {
    db.tables.transactions = [nimRow()];
    await queue();
    const again = await queue();
    expect(again.status).toBe(409);
    expect(db.tables.refund_queue).toHaveLength(1);
  });

  it.each([
    ['an order that was never paid on chain', { tx_hash: 'nim_intent_123' }, 400],
    ['a delivered order', { status: 'SUCCESS' }, 409],
    ['an already refunded order', { status: 'REFUNDED' }, 409],
    ['a stablecoin order', { blockchain: 'CELO', tx_hash: `0x${'b'.repeat(64)}` }, 400],
  ])('refuses %s', async (_label, over, status) => {
    db.tables.transactions = [nimRow(over)];
    const r = await queue();
    expect(r.status).toBe(status);
    expect(db.tables.refund_queue ?? []).toHaveLength(0);
  });

  it('is admin-only', async () => {
    authorized = false;
    db.tables.transactions = [nimRow()];
    expect((await queue()).status).toBe(401);
    expect(db.tables.refund_queue ?? []).toHaveLength(0);
  });
});
