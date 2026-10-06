import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ LATE PROVIDER OUTCOMES (src/lib/providerOutcome.ts) — ABAPAY_FULL_AUDIT.md P-5.
//
// A "delivered" that arrives after the vend was written off must never become delivery AND
// refund. A "failed/reversed" that arrives late must reach the refund queue, not just an alert.

vi.mock('server-only', () => ({}));

let db: FakeDb;
const enqueueRefund = vi.fn(async (p: { txHash: string }) => {
  const exists = db.tables.refund_queue.some((r) => r.tx_hash === p.txHash);
  if (!exists) db.tables.refund_queue.push({ id: `rq-${p.txHash}`, tx_hash: p.txHash, status: 'PENDING', refund_tx_hash: null });
  return { queued: !exists };
});
const sendTelegramAlert = vi.fn<(text: string) => Promise<void>>(async () => {});

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: (t: string) => sendTelegramAlert(t) }));
vi.mock('@/lib/refunds', () => ({ enqueueRefund: (p: { txHash: string }) => enqueueRefund(p) }));

const { recordLateDelivery, recordLateFailure } = await import('@/lib/providerOutcome');

function tx(status: string, over: Record<string, unknown> = {}) {
  const row = { id: 'r1', tx_hash: '0xabc', request_id: 'rid1', status, amount_usdt: 1, amount_naira: 1340, wallet_address: '0xw', token_used: 'USDC', blockchain: 'CELO', account_number: '080', network: 'MTN', service_category: 'AIRTIME', ...over };
  db.tables.transactions.push(row);
  return row;
}
function refund(status: string, refund_tx_hash: string | null = null) {
  db.tables.refund_queue.push({ id: 'q1', tx_hash: '0xabc', status, refund_tx_hash });
}
const txNow = () => db.tables.transactions[0];
const refundNow = () => db.tables.refund_queue[0];
const code = { purchased_code: '1234-5678', units: '10' };

beforeEach(() => {
  db = createFakeDb({ refund_queue: [] });
  enqueueRefund.mockClear();
  sendTelegramAlert.mockClear();
});

describe('recordLateDelivery', () => {
  it('records delivery for an in-flight order', async () => {
    expect(await recordLateDelivery(tx('PROCESSING'), code)).toBe('DELIVERED');
    expect(txNow()).toMatchObject({ status: 'SUCCESS', purchased_code: '1234-5678' });
  });

  it('is a no-op for an order already delivered (no second receipt)', async () => {
    expect(await recordLateDelivery(tx('SUCCESS'), code)).toBe('ALREADY');
  });

  it('withdraws a still-pending refund and delivers', async () => {
    const row = tx('FAILED_VENDING');
    refund('PENDING');
    expect(await recordLateDelivery(row, code)).toBe('DELIVERED');
    expect(txNow().status).toBe('SUCCESS');
    expect(refundNow()).toMatchObject({ status: 'REJECTED' });
  });

  it('delivers a FAILED row that never had a refund queued', async () => {
    expect(await recordLateDelivery(tx('FAILED_VENDING'), code)).toBe('DELIVERED');
    expect(txNow().status).toBe('SUCCESS');
  });

  it('DOUBLE-PAY GUARD: does not deliver while a refund payout is in flight', async () => {
    const row = tx('FAILED_VENDING');
    refund('PENDING', '0xrefundtx'); // operator broadcast refundUser(), not yet recorded
    expect(await recordLateDelivery(row, code)).toBe('FLAGGED');
    expect(txNow()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'DELIVERED_AFTER_REFUND' });
    expect(refundNow()).toMatchObject({ status: 'PENDING', refund_tx_hash: '0xrefundtx' });
  });

  it('DOUBLE-PAY GUARD: does not deliver once the refund is completed', async () => {
    const row = tx('FAILED_VENDING');
    refund('COMPLETED', '0xrefundtx');
    expect(await recordLateDelivery(row, code)).toBe('FLAGGED');
    expect(txNow().status).toBe('FAILED_VENDING');
  });

  it('DOUBLE-PAY GUARD: never turns a REFUNDED row into SUCCESS', async () => {
    expect(await recordLateDelivery(tx('REFUNDED'), code)).toBe('FLAGGED');
    expect(txNow()).toMatchObject({ status: 'REFUNDED', error_code: 'DELIVERED_AFTER_REFUND' });
    expect(sendTelegramAlert.mock.calls.some(([t]) => String(t).includes('DELIVERED AFTER REFUND'))).toBe(true);
  });
});

describe('recordLateFailure', () => {
  it('fails an in-flight order and queues its refund', async () => {
    expect(await recordLateFailure(tx('PROCESSING'), 'VTpass failed')).toBe('QUEUED');
    expect(txNow()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'PROVIDER_FAILED_LATE' });
    expect(enqueueRefund).toHaveBeenCalledTimes(1);
  });

  it('marks a reversed delivery REVERSED_NEEDS_REFUND and queues the refund', async () => {
    expect(await recordLateFailure(tx('SUCCESS'), 'VTpass reversed')).toBe('QUEUED');
    expect(txNow().status).toBe('REVERSED_NEEDS_REFUND');
    expect(db.tables.refund_queue).toHaveLength(1);
  });

  it('is idempotent — a second report queues nothing new', async () => {
    const row = tx('PROCESSING');
    await recordLateFailure(row, 'first');
    expect(await recordLateFailure({ ...row, status: 'FAILED_VENDING' }, 'second')).toBe('ALREADY');
    expect(db.tables.refund_queue).toHaveLength(1);
  });

  it('leaves an already-refunded order alone', async () => {
    expect(await recordLateFailure(tx('REFUNDED'), 'late')).toBe('ALREADY');
    expect(enqueueRefund).not.toHaveBeenCalled();
  });
});
