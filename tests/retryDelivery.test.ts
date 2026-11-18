import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Ops → Refunds → "Retry delivery": send a failed order to VTpass again instead of refunding it.
// The button exists only for payments the chain proves arrived (vault for Celo/Base, treasury for
// NIM), and nothing is ever sent twice.

vi.mock('server-only', () => ({}));

let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/utils/adminAuth', () => ({ verifyAdminRequest: async () => ({ authorized: true, address: '0xadmin' }) }));
vi.mock('@/lib/refundVerify', () => ({ verifyRefundOnChain: async () => ({}), completeRefund: async () => ({}), rememberRefundHash: async () => {}, refundHashAlreadyUsed: async () => false }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {}, sendTelegramToUser: async () => {} }));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));

let nimProof: { ok: boolean; code?: string; detail?: string } = { ok: true };
vi.mock('@/lib/nimiq', () => ({ LUNA_PER_NIM: 100_000, verifyNimPayment: vi.fn(async () => nimProof) }));
let evmProof: { status: string; detail: string } = { status: 'PAID', detail: 'paid' };
vi.mock('@/lib/orderPaymentProof', () => ({ proveOrderPaid: vi.fn(async () => evmProof) }));

let vendStatus: 'SUCCESS' | 'FAILED_VENDING' | 'TIMEOUT' = 'SUCCESS';
const executeVend = vi.fn(async (input: { txHash: string }) => {
  const row = db.tables.transactions.find((t) => t.tx_hash === input.txHash)!;
  row.status = vendStatus;
  return { success: vendStatus === 'SUCCESS', status: vendStatus, message: vendStatus === 'FAILED_VENDING' ? '087 again' : 'ok' };
});
vi.mock('@/lib/vend', () => ({ executeVend: (i: { txHash: string }) => executeVend(i), getStrictRequestId: () => '202611181500newrequest' }));

let requery: unknown = { code: '015', response_description: 'INVALID REQUEST ID' };
vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => requery })));

const { GET, POST } = await import('@/app/api/admin/refunds/route');

const NIM_HASH = 'a'.repeat(64);
const order = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1', blockchain: 'NIMIQ', tx_hash: NIM_HASH, status: 'FAILED_VENDING', error_code: '087', request_id: '202611181303old',
  wallet_address: 'NQ65 68XN 4V9C 3BP6 S1N9 HJBA 8XP3 0LQD JRVX', amount_usdt: 479, amount_naira: 100,
  service_id: 'mtn', service_category: 'AIRTIME', network: 'MTN', account_number: '08000000000', source_channel: 'NIMIQ', ...over,
});
const refundRow = (over: Record<string, unknown> = {}) => ({
  id: 'rf-1', transaction_id: 'tx-1', tx_hash: NIM_HASH, status: 'PENDING', refund_tx_hash: null, wallet_address: 'nq65', token_used: 'NIM', amount_crypto: 479, ...over,
});
const retry = async () => {
  const res = await POST(new Request('http://localhost/api/admin/refunds', { method: 'POST', body: JSON.stringify({ id: 'rf-1', action: 'RETRY_VEND' }) }));
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  db = createFakeDb({ transactions: [order()], refund_queue: [refundRow()] });
  nimProof = { ok: true };
  evmProof = { status: 'PAID', detail: 'paid' };
  vendStatus = 'SUCCESS';
  requery = { code: '015', response_description: 'INVALID REQUEST ID' };
  executeVend.mockClear();
});

describe('retry delivery instead of refunding', () => {
  it('delivers a proven NIM payment and closes the refund, with a fresh request id', async () => {
    const r = await retry();
    expect(r.json).toMatchObject({ success: true, status: 'SUCCESS' });
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(db.tables.transactions[0]).toMatchObject({ status: 'SUCCESS', request_id: '202611181500newrequest' });
    expect(db.tables.refund_queue[0]).toMatchObject({ status: 'REJECTED' });
  });

  it('never sends a NIM order whose payment the Nimiq chain does not prove', async () => {
    nimProof = { ok: false, code: 'WRONG_RECIPIENT', detail: 'not the treasury' };
    const r = await retry();
    expect(r.status).toBe(409);
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.refund_queue[0].status).toBe('PENDING');
  });

  it('never sends a Celo/Base order whose vault payment is not proven (a fake hash)', async () => {
    db.tables.transactions = [order({ blockchain: 'BASE', tx_hash: `0x${'d'.repeat(64)}`, token_used: 'USDC', amount_usdt: 1 })];
    db.tables.refund_queue = [refundRow({ tx_hash: `0x${'d'.repeat(64)}` })];
    evmProof = { status: 'NOT_PAID', detail: 'NOT_FOUND: no such transaction' };
    const r = await retry();
    expect(r.status).toBe(409);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('refuses an order that never carried a real payment hash', async () => {
    db.tables.transactions = [order({ tx_hash: 'preflight_nim_123' })];
    const r = await retry();
    expect(r.status).toBe(409);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('does not resend when VTpass says the original request was delivered', async () => {
    requery = { code: '000', content: { transactions: { status: 'delivered' } } };
    const r = await retry();
    expect(r.status).toBe(409);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('does not resend when VTpass cannot answer about the original request', async () => {
    requery = { code: '087', response_description: 'INVALID CREDENTIALS' };
    const r = await retry();
    expect(r.status).toBe(503);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('puts the refund back on the list when VTpass refuses again', async () => {
    vendStatus = 'FAILED_VENDING';
    const r = await retry();
    expect(r.json).toMatchObject({ success: false, status: 'FAILED_VENDING' });
    expect(db.tables.refund_queue[0].status).toBe('PENDING');
  });

  it('cannot be run twice on the same refund', async () => {
    await retry();
    const again = await retry();
    expect(again.status).toBe(409);
    expect(executeVend).toHaveBeenCalledTimes(1);
  });

  it('refuses a refund that was already paid out', async () => {
    db.tables.refund_queue = [refundRow({ status: 'COMPLETED', refund_tx_hash: 'b'.repeat(64) })];
    const r = await retry();
    expect(r.status).toBe(409);
    expect(executeVend).not.toHaveBeenCalled();
  });
});

describe('the refund list only offers Retry for proven payments', () => {
  it('marks a proven payment deliverable and an unproven one not', async () => {
    db.tables.transactions = [order(), order({ id: 'tx-2', tx_hash: 'c'.repeat(64) })];
    db.tables.refund_queue = [refundRow(), refundRow({ id: 'rf-2', transaction_id: 'tx-2', tx_hash: 'c'.repeat(64) })];
    const { verifyNimPayment } = await import('@/lib/nimiq');
    vi.mocked(verifyNimPayment).mockImplementation(async (hash: string) =>
      hash === NIM_HASH ? { ok: true } as never : { ok: false, code: 'AMOUNT_SHORT', detail: 'short' } as never);
    const res = await GET(new Request('http://localhost/api/admin/refunds'));
    const json = await res.json();
    const byId = Object.fromEntries(json.refunds.map((r: { id: string; deliverable: boolean }) => [r.id, r.deliverable]));
    expect(byId).toEqual({ 'rf-1': true, 'rf-2': false });
    vi.mocked(verifyNimPayment).mockImplementation(async () => nimProof as never);
  });
});
