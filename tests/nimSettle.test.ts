import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ SETTLING NIM ORDERS (src/lib/nimSettle.ts)
//
// One proven payment backs one order, the vend runs only after the proof, an undecided proof
// changes nothing, and the sweep settles payments whose app never reported them and expires
// orders nobody paid.

let db: FakeDb;
const alerts: string[] = [];
let proof: { ok: true; tx: { hash: string } } | { ok: false; code: string; detail: string };
let treasury = new Map<string, { hash: string }>();
const executeVend = vi.fn(async () => ({ success: true, status: 'SUCCESS' as const }));

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (m: string) => { alerts.push(m); } }));
vi.mock('@/lib/vend', () => ({ executeVend: (...a: unknown[]) => executeVend(...(a as [])), getStrictRequestId: () => 'req-nim' }));
const refunds: Record<string, unknown>[] = [];
vi.mock('@/lib/refunds', () => ({ enqueueRefund: async (p: Record<string, unknown>) => { refunds.push(p); db.tables.refund_queue = [...(db.tables.refund_queue || []), { id: 'rq' + refunds.length, tx_hash: p.txHash }]; return { queued: true }; } }));
vi.mock('@/lib/vendInput', () => ({ vendInputFromRow: (row: unknown, extra: unknown) => ({ row, extra }) }));
vi.mock('@/lib/nimiq', async () => {
  const actual = await vi.importActual<typeof import('@/lib/nimiq')>('@/lib/nimiq');
  return {
    ...actual,
    verifyNimPayment: async () => proof,
    recentTreasuryPayments: async () => treasury,
  };
});

const { settleNimIntent, reconcileNimIntents } = await import('@/lib/nimSettle');
const { paymentReference } = await import('@/lib/nimiq');

const INTENT = 'preflight_nim_order-1';
const HASH = 'a'.repeat(64);
const row = (over: Record<string, unknown> = {}) => ({
  id: 'n1', tx_hash: INTENT, status: 'PENDING', blockchain: 'NIMIQ', token_used: 'NIM', amount_usdt: 2431,
  wallet_address: 'NQ162SSN82TLSMQSKXT3Q01VCMALNU6F1LJG', service_category: 'AIRTIME', network: 'MTN',
  created_at: new Date(Date.now() - 10 * 60_000).toISOString(), ...over,
});
const tx = () => db.tables.transactions[0];

beforeEach(() => {
  alerts.length = 0;
  refunds.length = 0;
  executeVend.mockClear();
  proof = { ok: true, tx: { hash: HASH } };
  treasury = new Map();
  db = createFakeDb({ transactions: [row()] });
});

describe('settleNimIntent', () => {
  it('proven → attaches the hash, locks the row and vends once', async () => {
    const out = await settleNimIntent(tx() as never, HASH);
    expect(out.status).toBe('SUCCESS');
    expect(tx()).toMatchObject({ tx_hash: HASH, status: 'PROCESSING', request_id: 'req-nim' });
    expect(executeVend).toHaveBeenCalledTimes(1);
  });

  it('a second settle of the same order never vends again', async () => {
    await settleNimIntent(tx() as never, HASH);
    const again = await settleNimIntent(tx() as never, HASH);
    expect(again.status).not.toBe('SUCCESS');
    expect(executeVend).toHaveBeenCalledTimes(1);
  });

  it('undecided proof → row untouched, nothing vended, client keeps waiting', async () => {
    proof = { ok: false, code: 'UNCONFIRMED', detail: '3 of 10' };
    const out = await settleNimIntent(tx() as never, HASH);
    expect(out).toMatchObject({ status: 'TIMEOUT', verifying: true });
    expect(tx()).toMatchObject({ tx_hash: INTENT, status: 'PENDING' });
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('a definite mismatch → FAILED_VENDING, alerted, nothing vended', async () => {
    proof = { ok: false, code: 'AMOUNT_SHORT', detail: 'short' };
    const out = await settleNimIntent(tx() as never, HASH);
    expect(out).toMatchObject({ status: 'FAILED_VENDING', code: 'AMOUNT_SHORT' });
    expect(tx()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'AMOUNT_SHORT', tx_hash: INTENT });
    expect(alerts[0]).toMatch(/NIM PAYMENT REJECTED/);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('ATTACK: a hash already backing another order is refused', async () => {
    db.tables.transactions.push(row({ id: 'n2', tx_hash: HASH, status: 'SUCCESS' }));
    const out = await settleNimIntent(tx() as never, HASH);
    expect(out).toMatchObject({ status: 'FAILED_VENDING', code: 'PAYMENT_ALREADY_USED' });
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('refuses a malformed hash without reading the chain', async () => {
    expect(await settleNimIntent(tx() as never, '0x' + HASH)).toMatchObject({ code: 'BAD_HASH' });
  });

  it('an expired order that gets paid is alerted for manual handling, not vended', async () => {
    db.tables.transactions[0] = row({ status: 'EXPIRED' });
    const out = await settleNimIntent(tx() as never, HASH);
    expect(out).toMatchObject({ code: 'INTENT_EXPIRED' });
    expect(alerts[0]).toMatch(/PAID AFTER INTENT EXPIRED/);
    expect(executeVend).not.toHaveBeenCalled();
  });
});

describe('reconcileNimIntents', () => {
  it('settles an order whose payment reached the treasury but was never reported', async () => {
    treasury.set(paymentReference(INTENT), { hash: HASH });
    const r = await reconcileNimIntents({ force: true });
    expect(r).toMatchObject({ ok: true, settled: 1 });
    expect(tx()).toMatchObject({ tx_hash: HASH, status: 'PROCESSING' });
  });

  it('expires an order unpaid for over an hour, and leaves a recent one alone', async () => {
    db.tables.transactions = [
      row({ id: 'old', tx_hash: 'preflight_nim_old', created_at: new Date(Date.now() - 2 * 3600_000).toISOString() }),
      row({ id: 'new', tx_hash: 'preflight_nim_new' }),
    ];
    const r = await reconcileNimIntents({ force: true });
    expect(r).toMatchObject({ ok: true, expired: 1 });
    expect(db.tables.transactions.find((t) => t.id === 'old')?.status).toBe('EXPIRED');
    expect(db.tables.transactions.find((t) => t.id === 'new')?.status).toBe('PENDING');
  });
});

describe('reconcileNimIntents — a payment that arrives after its order expired', () => {
  const LATE = 'b'.repeat(64);
  const expired = (over: Record<string, unknown> = {}) => row({ status: 'EXPIRED', error_code: 'PREFLIGHT_UNCONFIRMED', request_id: 'req-late', created_at: new Date(Date.now() - 5 * 3600_000).toISOString(), ...over });

  beforeEach(() => {
    db = createFakeDb({ transactions: [expired()] });
    treasury.set(paymentReference(INTENT), { hash: LATE });
    proof = { ok: true, tx: { hash: LATE, value: 2_431 * 100_000 } as never };
  });

  it('refunds the NIM that arrived, to the ordering wallet, and alerts — never delivers late', async () => {
    const r = await reconcileNimIntents({ force: true });
    expect(r).toMatchObject({ ok: true, late: 1 });
    expect(refunds).toEqual([expect.objectContaining({ txHash: LATE, walletAddress: 'NQ162SSN82TLSMQSKXT3Q01VCMALNU6F1LJG', amountCrypto: 2431, tokenUsed: 'NIM', blockchain: 'NIMIQ' })]);
    expect(tx()).toMatchObject({ status: 'EXPIRED', error_code: 'NIM_LATE_PAYMENT' });
    expect(executeVend).not.toHaveBeenCalled();
    expect(alerts.some((a) => a.includes('LATE NIM PAYMENT'))).toBe(true);
  });

  it('never queues the same late payment twice', async () => {
    await reconcileNimIntents({ force: true });
    db.tables.transactions[0].error_code = 'PREFLIGHT_UNCONFIRMED'; // even if the mark were lost
    await reconcileNimIntents({ force: true });
    expect(refunds).toHaveLength(1);
  });

  it('only alerts (no refund) when the late transfer is not from the ordering wallet', async () => {
    proof = { ok: false, code: 'SENDER_MISMATCH', detail: 'other wallet' };
    await reconcileNimIntents({ force: true });
    expect(refunds).toHaveLength(0);
    expect(tx()).toMatchObject({ error_code: 'NIM_LATE_PAYMENT_UNVERIFIED' });
    expect(alerts.some((a) => a.includes('NOT FROM THE ORDERING WALLET'))).toBe(true);
  });

  it('tries again next sweep when the chain cannot be read', async () => {
    proof = { ok: false, code: 'RPC_UNAVAILABLE', detail: 'down' };
    await reconcileNimIntents({ force: true });
    expect(refunds).toHaveLength(0);
    expect(tx()).toMatchObject({ error_code: 'PREFLIGHT_UNCONFIRMED' });
  });

  it('leaves orders that expired long ago alone', async () => {
    db.tables.transactions = [expired({ created_at: new Date(Date.now() - 5 * 86_400_000).toISOString() })];
    await reconcileNimIntents({ force: true });
    expect(refunds).toHaveLength(0);
  });
});
