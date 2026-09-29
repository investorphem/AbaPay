import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { CELO_VAULT, CELO_TOKENS, PAYER, fakeClient, hash, transferLog, type FakeReceipt } from './helpers/chain';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ /api/pay/x402 — THE INTENT IS RECORDED BEFORE MONEY MOVES (ABAPAY_FULL_AUDIT.md P-3 / P-7).
//
// Drives the real route: signed X-PAYMENT header -> local checks -> intent row -> facilitator
// (a stubbed fetch) -> on-chain Transfer check (a fake chain) -> claim -> vend. And the
// reconciler that finishes whatever a dead request left open.

vi.mock('server-only', () => ({}));

let db: FakeDb;
let receipts: Record<string, FakeReceipt | Error> = {};
let authStates: Record<string, boolean | Error> = {};
let facilitator: { status: number; body: unknown } | Error;
let facilitatorCalls = 0;
let intentRowsAtSettle: number[] = [];
const executeVend = vi.fn(async (input: { vtRequestId: string }) => ({ success: true, status: 'SUCCESS', request_id: input.vtRequestId }));
const enqueueRefund = vi.fn(async () => ({ queued: true }));
const sendTelegramAlert = vi.fn(async (_text: string) => {});

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: (t: string) => sendTelegramAlert(t) }));
vi.mock('@/lib/vend', () => {
  let n = 0;
  return { executeVend: (i: { vtRequestId: string }) => executeVend(i), getStrictRequestId: () => `202609291200x402${String(++n).padStart(8, '0')}` };
});
vi.mock('@/lib/refunds', () => ({ enqueueRefund: () => enqueueRefund() }));
vi.mock('@/lib/parity', () => ({ isDuplicateElectricity: async () => false }));
vi.mock('@/lib/deai/services', () => ({ verifyAccount: async () => ({ success: true }) }));
let gate: { allowed: boolean; code?: string; reason?: string } = { allowed: true };
vi.mock('@/lib/serviceRules', () => ({
  getServiceRules: async () => ({ exchangeRate: 1340, x402FacilitatorFeeUsd: 0 }),
  computeServiceFee: () => 0,
  checkWebPayment: async () => gate,
}));
vi.mock('@/lib/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chain')>();
  return { ...actual, getPublicClient: () => fakeClient(receipts, authStates) };
});

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK = 'celo';
  process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = CELO_VAULT;
  process.env.CELO_X402_API_KEY = 'test-key';
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
});

// The facilitator and the route's own authorizationState RPC reads both go through fetch.
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  if (body.includes('"eth_call"')) {
    // authorizationState(payer, nonce): the nonce is the last 32 bytes of the calldata.
    const data = JSON.parse(body).params[0].data as string;
    const s = authStates[`0x${data.slice(-64)}`];
    if (s instanceof Error) throw s;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(s ? 1 : 0).toString(16).padStart(64, '0')}` }));
  }
  if (String(url).endsWith('/settle')) {
    facilitatorCalls++;
    intentRowsAtSettle.push(db.tables.transactions.filter((t) => String(t.tx_hash).startsWith('preflight_x402_')).length);
    if (facilitator instanceof Error) throw facilitator;
    return new Response(JSON.stringify(facilitator.body), { status: facilitator.status });
  }
  throw new Error(`unexpected fetch ${url}`);
});

const { POST } = await import('@/app/api/pay/x402/route');
const { reconcileX402Intents } = await import('@/lib/reconcileX402');
const { cleanupStalePreflights } = await import('@/lib/cleanupPreflights');

const bill = {
  serviceID: 'mtn', serviceCategory: 'AIRTIME', network: 'MTN', billersCode: '08012345678', phone: '08012345678',
  nairaAmount: '1340', token: 'USDC', wallet_address: PAYER, blockchain: 'CELO', variation_code: 'none', email: 'payer@example.com',
};

const NONCE = hash(77);
const nowSec = () => Math.floor(Date.now() / 1000);
function header(opts: { nonce?: string; value?: string; from?: string; validBefore?: number } = {}) {
  const authorization = {
    from: opts.from ?? PAYER, to: CELO_VAULT, value: opts.value ?? '1000000',
    validAfter: String(nowSec() - 86_400), validBefore: String(opts.validBefore ?? nowSec() + 3_600),
    nonce: opts.nonce ?? NONCE,
  };
  return Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:42220', payload: { signature: `0x${'ab'.repeat(65)}`, authorization } })).toString('base64');
}

async function pay(body: object = bill, xPayment: string | null = header()) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (xPayment) headers['x-payment'] = xPayment;
  const res = await POST(new Request('http://localhost/api/pay/x402', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}

const SETTLE_TX = hash(500);
const settledReceipt = (value = BigInt(1_000_000)): FakeReceipt => ({
  status: 'success',
  logs: [transferLog({ token: CELO_TOKENS.USDC.address, from: PAYER, to: CELO_VAULT, value })],
});
const facilitatorOk = () => ({ status: 200, body: { success: true, transaction: SETTLE_TX, payer: PAYER, network: 'celo' } });
// A refusal that is NOT retryable, so the route asks the chain once rather than polling for 14s.
const facilitatorRefuses = () => ({ status: 400, body: { success: false, errorReason: 'insufficient_funds', errorMessage: 'insufficient funds' } });

const intentRow = () => db.tables.transactions.find((t) => t.x402_nonce === NONCE);
const later = (minutes: number) => Date.now() + minutes * 60_000;

beforeEach(() => {
  db = createFakeDb();
  receipts = {};
  authStates = {};
  facilitator = facilitatorOk();
  facilitatorCalls = 0;
  intentRowsAtSettle = [];
  executeVend.mockClear();
  enqueueRefund.mockClear();
  sendTelegramAlert.mockClear();
  gate = { allowed: true };
});

describe('/api/pay/x402 — happy path', () => {
  it('answers a request with no payment with a 402 challenge and writes nothing', async () => {
    const r = await pay(bill, null);
    expect(r.status).toBe(402);
    expect(r.json.accepts[0]).toMatchObject({ scheme: 'exact', payTo: CELO_VAULT, maxAmountRequired: '1000000' });
    expect(db.tables.transactions).toHaveLength(0);
  });

  it('records the intent BEFORE settling, proves the Transfer on-chain, claims the row and vends once', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    const r = await pay();
    expect(intentRowsAtSettle).toEqual([1]); // the row already existed when the facilitator was called
    expect(r.json).toMatchObject({ status: 'SUCCESS', tx_hash: SETTLE_TX });
    expect(facilitatorCalls).toBe(1);
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(db.tables.transactions).toHaveLength(1);
    expect(db.tables.transactions[0]).toMatchObject({
      tx_hash: SETTLE_TX, status: 'PROCESSING', payment_method: 'X402',
      x402_payer: PAYER, x402_nonce: NONCE, x402_settle_tx: SETTLE_TX, amount_usdt: 1,
    });
  });
});

describe('/api/pay/x402 — refused BEFORE any money moves', () => {
  it('does not settle when the intent cannot be recorded (P-3)', async () => {
    db.failNextInsert = 'transactions';
    const r = await pay();
    expect(r.status).toBe(503);
    expect(r.json.retryable).toBe(true);
    expect(facilitatorCalls).toBe(0);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('refuses a payment with no bill details instead of settling and refunding it', async () => {
    const r = await pay({ token: 'USDC', blockchain: 'CELO', wallet_address: PAYER });
    expect(r.status).toBe(400);
    expect(r.json.errorCode).toBe('MISSING_BILL_DETAILS');
    expect(facilitatorCalls).toBe(0);
    expect(enqueueRefund).not.toHaveBeenCalled();
    expect(db.tables.transactions).toHaveLength(0);
  });

  it('refuses a switched-off service (or an open provider breaker) before settling', async () => {
    gate = { allowed: false, code: 'SERVICE_UNAVAILABLE', reason: 'paused' };
    const r = await pay();
    expect(r.status).toBe(409);
    expect(r.json.errorCode).toBe('SERVICE_UNAVAILABLE');
    expect(facilitatorCalls).toBe(0);
    expect(db.tables.transactions).toHaveLength(0);
  });

  it('still answers a crawler probe with a 402 even when the service is paused', async () => {
    gate = { allowed: false, code: 'SERVICE_UNAVAILABLE', reason: 'paused' };
    expect((await pay(bill, null)).status).toBe(402);
  });

  it('refuses a payment signed by a different wallet than the one paying', async () => {
    const r = await pay(bill, header({ from: '0x3333333333333333333333333333333333333333' }));
    expect(r.status).toBe(400);
    expect(r.json.errorCode).toBe('PAYER_MISMATCH');
    expect(facilitatorCalls).toBe(0);
    expect(db.tables.transactions).toHaveLength(0);
  });

  it('answers the SAME signed header a second time from the existing row, without settling again', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    await pay();
    db.tables.transactions[0].status = 'SUCCESS';
    const again = await pay();
    expect(facilitatorCalls).toBe(1);
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(again.json).toMatchObject({ status: 'SUCCESS', tx_hash: SETTLE_TX });
  });
});

describe('/api/pay/x402 — the facilitator is not the proof (P-7)', () => {
  it('does not vend when the reported transaction has no matching Transfer', async () => {
    receipts[SETTLE_TX] = { status: 'success', logs: [] };
    const r = await pay();
    expect(executeVend).not.toHaveBeenCalled();
    expect(r.json.tx_hash).toBeUndefined(); // x402Pay.ts reads a tx_hash as "money moved"
    expect(intentRow()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'X402_TX_UNVERIFIED', x402_settle_tx: SETTLE_TX });
  });

  it('does not vend a Transfer that is short of the signed amount', async () => {
    receipts[SETTLE_TX] = settledReceipt(BigInt(10));
    await pay();
    expect(executeVend).not.toHaveBeenCalled();
    expect(intentRow()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'X402_TX_UNVERIFIED' });
  });

  it('keeps the intent PENDING with the hash when the chain cannot be read, and the reconciler vends it later', async () => {
    receipts[SETTLE_TX] = new Error('socket hang up');
    const r = await pay();
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: 'TIMEOUT', verifying: true });
    expect(executeVend).not.toHaveBeenCalled();
    expect(intentRow()).toMatchObject({ status: 'PENDING', x402_settle_tx: SETTLE_TX });

    receipts[SETTLE_TX] = settledReceipt();
    const rec = await reconcileX402Intents({ force: true, now: later(3) });
    expect(rec).toMatchObject({ ok: true, vended: 1 });
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(db.tables.transactions[0]).toMatchObject({ tx_hash: SETTLE_TX, status: 'PROCESSING' });

    // A second run finds nothing left to do.
    await reconcileX402Intents({ force: true, now: later(10) });
    expect(executeVend).toHaveBeenCalledTimes(1);
  });
});

describe('/api/pay/x402 — refusals', () => {
  it('closes a refusal the chain proves moved nothing as FAILED_PAYMENT (not left PENDING)', async () => {
    facilitator = facilitatorRefuses();
    authStates[NONCE] = false;
    const r = await pay();
    expect(r.status).toBe(402);
    expect(executeVend).not.toHaveBeenCalled();
    expect(intentRow()).toMatchObject({ status: 'FAILED_PAYMENT', error_code: 'X402_SETTLE_REFUSED' });
  });

  it('leaves a refusal PENDING when the chain cannot vouch for it; the reconciler flags it once it reads as spent', async () => {
    facilitator = facilitatorRefuses();
    authStates[NONCE] = new Error('rpc down');
    await pay();
    expect(intentRow()).toMatchObject({ status: 'PENDING' });

    authStates[NONCE] = true;
    const rec = await reconcileX402Intents({ force: true, now: later(3) });
    expect(rec.flagged).toBe(1);
    expect(intentRow()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'X402_SETTLED_UNCONFIRMED', tx_hash: `x402_unconfirmed_CELO_${NONCE}` });
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('keeps the payment visible when the facilitator refuses but the authorization was spent (settled without hash)', async () => {
    // A RETRYABLE refusal: the route polls authorizationState, which reads spent.
    facilitator = { status: 400, body: { success: false, errorReason: 'invalid_payload', errorMessage: 'unable to estimate gas' } };
    authStates[NONCE] = true;
    const r = await pay();
    expect(r.json.settled).toBe(true);
    expect(db.tables.transactions).toHaveLength(1); // the SAME intent row, not a second insert
    expect(intentRow()).toMatchObject({ status: 'FAILED_VENDING', error_code: 'X402_SETTLED_UNCONFIRMED', tx_hash: `x402_unconfirmed_CELO_${NONCE}` });
  }, 20_000);

  it('flags a refused payment that settles LATE', async () => {
    facilitator = facilitatorRefuses();
    authStates[NONCE] = false;
    await pay();
    authStates[NONCE] = true; // the facilitator's queued submission landed after all
    await reconcileX402Intents({ force: true, now: later(3) });
    expect(intentRow()).toMatchObject({ status: 'FAILED_PAYMENT', error_code: 'X402_LATE_SETTLEMENT' });
    expect(sendTelegramAlert.mock.calls.some(([t]) => String(t).includes('LATE SETTLEMENT'))).toBe(true);
  });
});

describe('reconcileX402Intents / cleanupStalePreflights', () => {
  it('expires an intent whose authorization is unspent and past validBefore', async () => {
    facilitator = new Error('ECONNRESET'); // request died mid-flight: intent left PENDING, no hash
    await pay(bill, header({ validBefore: nowSec() + 600 }));
    expect(intentRow()).toMatchObject({ status: 'PENDING' });

    authStates[NONCE] = false;
    expect((await reconcileX402Intents({ force: true, now: later(5) })).pending).toBe(1); // still spendable
    expect((await reconcileX402Intents({ force: true, now: later(20) })).expired).toBe(1);
    expect(intentRow()).toMatchObject({ status: 'EXPIRED', error_code: 'X402_NOT_SETTLED' });
  });

  it('the generic preflight sweep never expires an x402 intent', async () => {
    facilitator = new Error('ECONNRESET');
    await pay();
    intentRow()!.created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    await cleanupStalePreflights({ force: true });
    expect(intentRow()).toMatchObject({ status: 'PENDING' });
  });
});
