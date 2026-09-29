import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { CELO_VAULT, CELO_TOKENS, PAYER, celoPayment, fakeClient, hash, paymentReceivedLog, type FakeReceipt } from './helpers/chain';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';
import { parseUnits } from 'viem';

// ⚡ /api/pay END-TO-END (intent -> settle -> vend), against an in-memory `transactions` table
// with production's UNIQUE tx_hash, and a fake chain returning encoded vault receipts.
//
// The two ATTACK groups are ABAPAY_FULL_AUDIT.md P-1 (replay / double-vend via the intent
// upsert) and P-2 (USDm dust recorded as USDC). They run WITHOUT migration 026's DB guard —
// they prove the route itself is correct, so the guard is defence in depth, not the only wall.

vi.mock('server-only', () => ({}));

let db: FakeDb;
let receipts: Record<string, FakeReceipt | Error> = {};
const executeVend = vi.fn(async (input: any) => ({ success: true, status: 'SUCCESS', request_id: input.vtRequestId, purchased_code: null }));
const sendTelegramAlert = vi.fn(async (_text: string) => {});
let rateLimited = false;

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: (t: string) => sendTelegramAlert(t) }));
vi.mock('@/lib/vend', () => {
  let n = 0;
  return {
    executeVend: (input: any) => executeVend(input),
    getStrictRequestId: () => `202609281200req${String(++n).padStart(6, '0')}`,
  };
});
vi.mock('@/lib/discounts', () => ({
  getActiveDiscountForService: async () => null,
  computeDiscountNgn: async () => ({ discountNgn: 0, discountPhone: null }),
}));
vi.mock('@/lib/parity', () => ({ isDuplicateElectricity: async () => false }));
vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: async () => (rateLimited ? new Response('{}', { status: 429 }) : null),
}));
vi.mock('@/lib/chain', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, getPublicClient: () => fakeClient(receipts) };
});

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK = 'celo';
  process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = CELO_VAULT;
});

const { POST } = await import('@/app/api/pay/route');

const post = async (body: any) => {
  const res = await POST(new Request('http://localhost/api/pay', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};

// What page.tsx's buildBackendPayload() sends for ₦1,340 of MTN airtime paid in USDC on Celo.
const bill = {
  serviceID: 'mtn', serviceCategory: 'AIRTIME', network: 'MTN', billersCode: '08012345678',
  amount: '1.0000', nairaAmount: '1340', token: 'USDC', variation_code: 'none',
  phone: '08012345678', email: 'payer@example.com', wallet_address: PAYER,
  source_channel: 'WEB', blockchain: 'CELO',
};

const goodReceipt = (): FakeReceipt => ({ status: 'success', logs: [celoPayment('USDC', '1.0', 'mtn', '08012345678')] });

async function intent(extra: any = {}) {
  const r = await post({ ...bill, intent_only: true, ...extra });
  return r;
}

beforeEach(() => {
  db = createFakeDb();
  receipts = {};
  executeVend.mockClear();
  sendTelegramAlert.mockClear();
  rateLimited = false;
});

describe('/api/pay intent', () => {
  it('records a PENDING row under a server-generated intent id and returns it', async () => {
    const r = await intent();
    expect(r.status).toBe(200);
    expect(r.json.intent_id).toMatch(/^preflight_[0-9a-f-]{36}$/);
    const rows = db.tables.transactions;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tx_hash: r.json.intent_id, status: 'PENDING', token_used: 'USDC', amount_usdt: 1, blockchain: 'CELO' });
  });

  it('still accepts a legacy client-supplied preflight id (older cached bundles), but only as a fresh insert', async () => {
    const r = await intent({ txHash: 'preflight_0xabc_1700000000000' });
    expect(r.json.intent_id).toBe('preflight_0xabc_1700000000000');
    const again = await intent({ txHash: 'preflight_0xabc_1700000000000' });
    expect(again.status).toBe(409);
    expect(db.tables.transactions).toHaveLength(1);
  });

  it('refuses an intent that carries a real transaction hash', async () => {
    const r = await intent({ txHash: hash(1) });
    expect(r.status).toBe(400);
    expect(db.tables.transactions).toHaveLength(0);
  });

  it('refuses an underpriced intent before anything is signed', async () => {
    const r = await intent({ amount: '0.5' });
    expect(r.status).toBe(400);
    expect(db.tables.transactions).toHaveLength(0);
  });
});

describe('/api/pay settle', () => {
  it('verifies on-chain, locks and vends exactly once', async () => {
    const { json: i } = await intent();
    receipts[hash(1)] = goodReceipt();
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(r.json.status).toBe('SUCCESS');
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(db.tables.transactions[0]).toMatchObject({ tx_hash: hash(1), status: 'PROCESSING' });
  });

  it('vends from the STORED row, not from the settle request body', async () => {
    const { json: i } = await intent({ variation_code: 'mtn-100mb' });
    receipts[hash(1)] = goodReceipt();
    // Settle body tries to upgrade the plan and redirect the phone after paying.
    await post({ ...bill, variation_code: 'mtn-100gb-premium', phone: '08099999999', email: 'x@evil.test', txHash: hash(1), preflight_hash: i.intent_id });
    const input = executeVend.mock.calls[0][0];
    expect(input).toMatchObject({ variation_code: 'mtn-100mb', phone: '08012345678', email: 'payer@example.com', billersCode: '08012345678', serviceID: 'mtn' });
  });

  it('settling the same payment twice vends once and answers from the row', async () => {
    const { json: i } = await intent();
    receipts[hash(1)] = goodReceipt();
    await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    db.tables.transactions[0].status = 'SUCCESS';
    db.tables.transactions[0].purchased_code = '1111-2222';
    const again = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(again.json).toEqual({ success: true, status: 'SUCCESS' }); // no token leaked to a hash-holder
  });

  it('leaves the row PENDING with the hash attached when the chain cannot be read, and never vends', async () => {
    const { json: i } = await intent();
    receipts[hash(1)] = new Error('socket hang up');
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: 'TIMEOUT', verifying: true });
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.transactions[0]).toMatchObject({ tx_hash: hash(1), status: 'PENDING' });

    // Chain recovers; the payer's retry (found by hash now) verifies and vends.
    receipts[hash(1)] = goodReceipt();
    const retry = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(retry.json.status).toBe('SUCCESS');
    expect(executeVend).toHaveBeenCalledTimes(1);
  });

  it('marks a reverted payment FAILED without attaching its hash', async () => {
    const { json: i } = await intent();
    receipts[hash(1)] = { status: 'reverted', logs: [] };
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(r.status).toBe(400);
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.transactions[0]).toMatchObject({ tx_hash: i.intent_id, status: 'FAILED_VENDING', error_code: 'REVERTED' });
  });

  it('refuses a settle for a hash with no intent row, and alerts', async () => {
    receipts[hash(1)] = goodReceipt();
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: 'preflight_does_not_exist' });
    expect(r.status).toBe(404);
    expect(executeVend).not.toHaveBeenCalled();
    expect(sendTelegramAlert).toHaveBeenCalled();
  });
});

describe('ATTACK P-1: replay / double-vend', () => {
  async function completedPayment(status: 'SUCCESS' | 'REFUNDED' | 'FAILED_VENDING') {
    const { json: i } = await intent();
    receipts[hash(1)] = goodReceipt();
    await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    db.tables.transactions[0].status = status;
    executeVend.mockClear();
  }

  for (const status of ['SUCCESS', 'REFUNDED', 'FAILED_VENDING'] as const) {
    it(`cannot reset a ${status} row to PENDING through intent_only`, async () => {
      await completedPayment(status);
      const r = await intent({ txHash: hash(1), wallet_address: '0x9999999999999999999999999999999999999999' });
      expect(r.status).toBe(400);
      expect(db.tables.transactions.find((t) => t.tx_hash === hash(1))).toMatchObject({ status, wallet_address: PAYER.toLowerCase() });
    });

    it(`cannot re-vend a ${status} payment by attaching its hash to a fresh intent`, async () => {
      await completedPayment(status);
      const { json: fresh } = await intent();
      const r = await post({ ...bill, txHash: hash(1), preflight_hash: fresh.intent_id });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('PAYMENT_ALREADY_USED');
      expect(executeVend).not.toHaveBeenCalled();
    });

    it(`cannot re-vend a ${status} payment by settling its hash with no intent`, async () => {
      await completedPayment(status);
      await post({ ...bill, txHash: hash(1) });
      expect(executeVend).not.toHaveBeenCalled();
    });
  }
});

describe('ATTACK P-2: token / decimals confusion', () => {
  it('refuses USDm dust recorded as a USDC payment and does not vend', async () => {
    const { json: i } = await intent();
    // payBill(USDm, 'mtn', '08012345678', 1_000_000) — the integer parseUnits("1", 6) produces,
    // which in an 18-decimal token is 1e-12 USDm.
    receipts[hash(1)] = {
      status: 'success',
      logs: [paymentReceivedLog({ token: CELO_TOKENS.USDm.address, serviceType: 'mtn', accountNumber: '08012345678', amountWei: parseUnits('1', 6) })],
    };
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('TOKEN_MISMATCH');
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.transactions[0]).toMatchObject({ status: 'FAILED_VENDING', error_code: 'TOKEN_MISMATCH', tx_hash: i.intent_id });
  });

  it('refuses a payment for a different account than the intent recorded', async () => {
    const { json: i } = await intent();
    receipts[hash(1)] = { status: 'success', logs: [celoPayment('USDC', '1.0', 'mtn', '08099999999')] };
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(r.json.code).toBe('ACCOUNT_MISMATCH');
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('refuses an underpayment in the right token', async () => {
    const { json: i } = await intent();
    receipts[hash(1)] = { status: 'success', logs: [celoPayment('USDC', '0.5', 'mtn', '08012345678')] };
    const r = await post({ ...bill, txHash: hash(1), preflight_hash: i.intent_id });
    expect(r.json.code).toBe('AMOUNT_SHORT');
    expect(executeVend).not.toHaveBeenCalled();
  });
});

describe('/api/pay cancel', () => {
  it('deletes only a PENDING preflight row, never a real hash', async () => {
    const { json: i } = await intent();
    expect((await post({ txHash: hash(1), cancel_intent: true })).status).toBe(400);
    expect(db.tables.transactions).toHaveLength(1);
    await post({ txHash: i.intent_id, cancel_intent: true });
    expect(db.tables.transactions).toHaveLength(0);
  });
});
