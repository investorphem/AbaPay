import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// M7: the stuck-payment reconciler. Paid on-chain, never finished. It may only ever ASK the
// provider (requery); it never re-sends. Delivered → complete, failed → refund, no record →
// tell an operator once.

let db: FakeDb;
let requery: Record<string, unknown> = {};
let monnify: { status: string; raw: unknown } | null = null;
const alerts: string[] = [];
const sms: string[] = [];
const enqueueRefund = vi.fn<(...a: unknown[]) => Promise<{ queued: boolean }>>(async () => ({ queued: true }));
const finalizeMonnifyTransfer = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(requery)));

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (m: string) => { alerts.push(m); } }));
vi.mock('@/lib/messaging', () => ({ sendAbaPaySms: async (_to: string, m: string) => { sms.push(m); } }));
vi.mock('@/lib/vtpass', () => ({ getHeaders: () => ({}) }));
vi.mock('@/lib/refunds', () => ({ enqueueRefund: (...a: unknown[]) => enqueueRefund(...a) }));
vi.mock('@/lib/receiptEmail', () => ({ buildReceiptEmail: () => '<p>receipt</p>' }));
vi.mock('@/lib/monnifyVend', () => ({
  requeryMonnifyTransfer: async () => monnify,
  finalizeMonnifyTransfer: (...a: unknown[]) => finalizeMonnifyTransfer(...a),
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));
vi.stubGlobal('fetch', fetchMock);

const { reconcileStuckRow, reconcileStuckProcessing } = await import('@/lib/reconcileStuck');

const BASE = 'https://sandbox.vtpass.com/api';
const row = (over: Record<string, unknown> = {}) => ({
  id: 't1', tx_hash: '0x' + 'c'.repeat(64), status: 'PROCESSING', request_id: 'req-1', service_category: 'AIRTIME',
  service_id: 'mtn', network: 'MTN', account_number: '08012345678', amount_usdt: 1, amount_naira: 1340, wallet_address: '0xABC', ...over,
});
const tx = () => db.tables.transactions[0];

beforeEach(() => {
  alerts.length = 0; sms.length = 0;
  enqueueRefund.mockClear(); finalizeMonnifyTransfer.mockClear(); fetchMock.mockClear();
  requery = {}; monnify = null;
  db = createFakeDb({ transactions: [row()] });
});

describe('reconcileStuckRow (VTpass)', () => {
  it('delivered → SUCCESS, and only ever asks /requery', async () => {
    requery = { content: { transactions: { status: 'delivered' } } };
    expect(await reconcileStuckRow(row(), BASE)).toBe('reconciled');
    expect(tx().status).toBe('SUCCESS');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${BASE}/requery`]);
    expect(alerts[0]).toMatch(/RECOVERED STUCK PAYMENT/);
  });

  it('delivered electricity without the token yet → wait, never complete without it', async () => {
    db.tables.transactions[0] = row({ service_category: 'ELECTRICITY', variation_code: 'prepaid' });
    requery = { content: { transactions: { status: 'delivered' } } };
    expect(await reconcileStuckRow(tx(), BASE)).toBe('pending');
    expect(tx().status).toBe('PROCESSING');
  });

  it('delivered electricity with a token → completes and texts the token', async () => {
    db.tables.transactions[0] = row({ service_category: 'ELECTRICITY', variation_code: 'prepaid' });
    requery = { content: { transactions: { status: 'delivered' } }, purchased_code: 'Token : 1234-5678-9012-3456-7890' };
    expect(await reconcileStuckRow(tx(), BASE)).toBe('reconciled');
    expect(tx().purchased_code).toBeTruthy();
    expect(sms).toHaveLength(1);
  });

  it('failed → FAILED_VENDING and a refund is queued', async () => {
    requery = { content: { transactions: { status: 'failed' } } };
    expect(await reconcileStuckRow(row(), BASE)).toBe('reconciled');
    expect(tx()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'RECONCILED_FAILED' });
    expect(enqueueRefund).toHaveBeenCalledTimes(1);
    expect(enqueueRefund.mock.calls[0][0]).toMatchObject({ txHash: row().tx_hash, amountCrypto: 1 });
  });

  it('a row someone else already finished is left alone (no double refund)', async () => {
    requery = { content: { transactions: { status: 'failed' } } };
    db.tables.transactions[0].status = 'SUCCESS';
    expect(await reconcileStuckRow(row(), BASE)).toBe('resolved_elsewhere');
    expect(enqueueRefund).not.toHaveBeenCalled();
  });

  it('VTpass has no record → one alert, flagged so it never repeats', async () => {
    expect(await reconcileStuckRow(row(), BASE)).toBe('alerted');
    expect(tx().error_code).toBe('STUCK_ALERTED');
    expect(await reconcileStuckRow(tx(), BASE)).toBe('skipped');
    expect(alerts).toHaveLength(1);
  });

  it('still processing at VTpass → pending, nothing written', async () => {
    requery = { content: { transactions: { status: 'pending' } }, response_description: 'TRANSACTION PROCESSING' };
    expect(await reconcileStuckRow(row(), BASE)).toBe('pending');
    expect(tx()).toMatchObject({ status: 'PROCESSING' });
    expect(tx().error_code).toBeUndefined();
  });

  it('no request_id → alert, nothing sent anywhere', async () => {
    expect(await reconcileStuckRow(row({ request_id: null }), BASE)).toBe('alerted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckRow (BANK via Monnify)', () => {
  const bank = () => row({ service_category: 'BANK', request_id: 'ref-1' });

  it('Monnify success → finalized as SUCCESS', async () => {
    monnify = { status: 'SUCCESS', raw: {} };
    expect(await reconcileStuckRow(bank(), BASE)).toBe('reconciled');
    expect(finalizeMonnifyTransfer.mock.calls[0][0]).toMatchObject({ outcome: 'SUCCESS', reference: 'ref-1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Monnify failure → finalized as FAILED', async () => {
    monnify = { status: 'FAILED', raw: {} };
    expect(await reconcileStuckRow(bank(), BASE)).toBe('reconciled');
    expect(finalizeMonnifyTransfer.mock.calls[0][0]).toMatchObject({ outcome: 'FAILED' });
  });

  it('Monnify has no record → alert once', async () => {
    expect(await reconcileStuckRow(bank(), BASE)).toBe('alerted');
    expect(tx().error_code).toBe('STUCK_ALERTED');
  });

  it('Monnify still processing → pending', async () => {
    monnify = { status: 'PENDING', raw: {} };
    expect(await reconcileStuckRow(bank(), BASE)).toBe('pending');
  });
});

describe('reconcileStuckProcessing', () => {
  it('sweeps only old, real (non-preflight) rows', async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    db.tables.transactions = [
      row({ id: 'a', created_at: old }),
      row({ id: 'b', tx_hash: 'preflight_x', status: 'PENDING', created_at: old }),
      row({ id: 'c', tx_hash: '0x' + 'd'.repeat(64), created_at: new Date().toISOString() }),
    ];
    requery = { content: { transactions: { status: 'delivered' } } };
    expect(await reconcileStuckProcessing({ force: true })).toMatchObject({ ok: true, reconciled: 1 });
    expect(db.tables.transactions.map((r) => r.status)).toEqual(['SUCCESS', 'PENDING', 'PROCESSING']);
    expect(await reconcileStuckProcessing()).toMatchObject({ skipped: true });
  });
});
