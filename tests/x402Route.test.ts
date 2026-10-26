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
const sendTelegramAlert = vi.fn<(text: string) => Promise<void>>(async () => {});

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: (t: string) => sendTelegramAlert(t) }));
vi.mock('@/lib/vend', () => {
  let n = 0;
  return { executeVend: (i: { vtRequestId: string }) => executeVend(i), getStrictRequestId: () => `202609291200x402${String(++n).padStart(8, '0')}` };
});
vi.mock('@/lib/refunds', () => ({ enqueueRefund: () => enqueueRefund() }));
vi.mock('@/lib/parity', () => ({ isDuplicateElectricity: async () => false }));
const verifyAccount = vi.fn<(...args: unknown[]) => Promise<{ success: boolean }>>(async () => ({ success: true }));
vi.mock('@/lib/deai/services', () => ({ verifyAccount: (...args: unknown[]) => verifyAccount(...args) }));
let gate: { allowed: boolean; code?: string; reason?: string } = { allowed: true };
vi.mock('@/lib/serviceRules', () => ({
  getServiceRules: async () => ({ exchangeRate: 1340, x402FacilitatorFeeUsd: 0 }),
  computeServiceFee: () => 0,
  checkWebPayment: async () => gate,
}));
vi.mock('@/lib/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chain')>();
  return {
    ...actual,
    getPublicClient: () => ({
      ...fakeClient(receipts, authStates),
      simulateContract: async () => { if (simulateRevert) throw simulateRevert; return { result: undefined }; },
    }),
  };
});
let simulateRevert: Error | null = null;

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK = 'celo';
  process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = CELO_VAULT;
  process.env.CELO_X402_API_KEY = 'test-key';
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
});

// The facilitator and the route's own authorizationState RPC reads both go through fetch.
let lastSettleBody: Record<string, unknown> = {};
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
    lastSettleBody = JSON.parse(body || '{}');
    intentRowsAtSettle.push(db.tables.transactions.filter((t) => String(t.tx_hash).startsWith('preflight_x402_')).length);
    if (facilitator instanceof Error) throw facilitator;
    return new Response(JSON.stringify(facilitator.body), { status: facilitator.status });
  }
  throw new Error(`unexpected fetch ${url}`);
});

const { POST, GET } = await import('@/app/api/pay/x402/route');
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
  verifyAccount.mockClear();
  enqueueRefund.mockClear();
  sendTelegramAlert.mockClear();
  gate = { allowed: true };
  simulateRevert = null;
});

describe('/api/pay/x402 — discovery probe (GET)', () => {
  // x402 crawlers GET the resource to confirm it's a real x402 endpoint before ever paying.
  it('answers with a 402 challenge, signs nothing and writes nothing', async () => {
    const res = await GET(new Request('http://localhost/api/pay/x402'));
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.accepts.length).toBeGreaterThan(0);
    expect(json.accepts[0]).toMatchObject({ scheme: 'exact', payTo: CELO_VAULT });
    expect(facilitatorCalls).toBe(0);
    expect(db.tables.transactions).toHaveLength(0);
  });

  // celo-org/buy-skill#58 (2026-10-20): the body said x402Version 1 while its networks were CAIP-2
  // (the v2 form), so Celo's `buy` CLI read the Celo offers as "not Celo" and couldn't pay.
  it('declares x402 v2 in the body as in the header, since every offer names its network in CAIP-2', async () => {
    const res = await GET(new Request('http://localhost/api/pay/x402'));
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(body.accepts.every((a: { network: string }) => /^eip155:\d+$/.test(a.network))).toBe(true);
    const header = JSON.parse(Buffer.from(String(res.headers.get('payment-required')), 'base64').toString());
    expect(header.x402Version).toBe(2);
    expect(header.accepts.map((a: { network: string }) => a.network)).toEqual(body.accepts.map((a: { network: string }) => a.network));
  });

  // 2026-10-25: four offers each carrying the Bazaar block made the header ~21.7 KB, over Node's
  // 16 KB response-header limit, so Node's fetch threw UND_ERR_HEADERS_OVERFLOW before reading it.
  it('keeps the payment-required header small enough for Node clients, with the Bazaar block once at the top level', async () => {
    const res = await GET(new Request('http://localhost/api/pay/x402'));
    const raw = String(res.headers.get('payment-required'));
    expect(raw.length).toBeLessThan(8 * 1024);
    const header = JSON.parse(Buffer.from(raw, 'base64').toString());
    expect(header.extensions?.bazaar).toBeTruthy();
    expect(header.accepts.length).toBeGreaterThan(1);
    expect(header.accepts.every((a: Record<string, unknown>) => !('extensions' in a))).toBe(true);
  });

  it("carries each token's own EIP-712 domain, so a payer signs against the right contract", async () => {
    const { accepts } = await (await GET(new Request('http://localhost/api/pay/x402'))).json();
    const usdc = accepts.find((a: { asset: string }) => a.asset.toLowerCase() === CELO_TOKENS.USDC.address);
    expect(usdc.extra).toMatchObject({ name: 'USDC', version: '2', primaryType: 'TransferWithAuthorization' });
  });
});

describe('/api/pay/x402 — happy path', () => {
  // Our web app always sends source_channel 'WEB'; anything else on this rail is an outside agent
  // and must not be announced as "🌐 Web App" (2026-10-24).
  it('labels a payment that names no source (an outside agent) AGENT, and only the web app WEB', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    await pay(bill);
    expect(db.tables.transactions[0].source_channel).toBe('AGENT');
  });

  it('keeps WEB for the first-party web app', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    await pay({ ...bill, source_channel: 'WEB' });
    expect(db.tables.transactions[0].source_channel).toBe('WEB');
  });

  it('records what the paying agent said about itself for the admin ledger, and never echoes it back', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    const res = await POST(new Request('http://localhost/api/pay/x402', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': header(), 'user-agent': 'earmark/1.0', 'x-agent-name': 'Earmark', 'x-agent-id': '9806' },
      body: JSON.stringify(bill),
    }));
    const json = await res.json();
    await new Promise((r) => setTimeout(r, 0)); // the write runs after the response
    expect(db.tables.payment_client_info).toEqual([expect.objectContaining({
      transaction_id: db.tables.transactions[0].id, wallet: PAYER.toLowerCase(),
      user_agent: 'earmark/1.0', declared_agent: 'Earmark', declared_agent_id: '9806',
    })]);
    expect(JSON.stringify(json)).not.toMatch(/Earmark|earmark\/1\.0/);
  });

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
    db.tables.onchain_payments = [{ chain: 'CELO', payer: PAYER.toLowerCase(), tx_hash: SETTLE_TX, amount_usd: 1, block_time: new Date().toISOString() }];
    await reconcileX402Intents({ force: true, now: later(3) });
    expect(intentRow()).toMatchObject({ status: 'FAILED_PAYMENT', error_code: 'X402_LATE_SETTLEMENT' });
    expect(sendTelegramAlert.mock.calls.some(([t]) => String(t).includes('LATE SETTLEMENT'))).toBe(true);
  });
});

describe('x402 — cancelled authorizations and v2 payloads', () => {
  it('a refused authorization that was CANCELLED (used, but no payment reached the vault) is closed as nothing owed, without an alarm', async () => {
    facilitator = facilitatorRefuses();
    authStates[NONCE] = false;
    await pay();
    authStates[NONCE] = true; // cancelAuthorization marks it used too
    db.tables.onchain_payments = [];
    sendTelegramAlert.mockClear();
    await reconcileX402Intents({ force: true, now: later(3) });
    expect(intentRow()).toMatchObject({ error_code: 'X402_SETTLE_REFUSED' }); // still waiting for the index
    await reconcileX402Intents({ force: true, now: later(60) });
    expect(intentRow()).toMatchObject({ status: 'FAILED_PAYMENT', error_code: 'X402_AUTH_CANCELLED' });
    expect(sendTelegramAlert.mock.calls.some(([t]) => String(t).includes('LATE SETTLEMENT'))).toBe(false);
  });

  it('a v2 payment (scheme inside `accepted`) is settled as clean v1: scheme lifted, accepted dropped', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    const flat = JSON.parse(Buffer.from(header(), 'base64').toString());
    const { scheme: _s, ...noScheme } = flat;
    void _s;
    const v2 = Buffer.from(JSON.stringify({ ...noScheme, x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:42220', asset: CELO_TOKENS.USDC.address } })).toString('base64');
    const r = await pay(bill, v2);
    expect(r.json.status).toBe('SUCCESS');
    const sent = lastSettleBody.paymentPayload as Record<string, unknown>;
    expect(sent).toMatchObject({ scheme: 'exact', x402Version: 1, network: 'celo' });
    expect(sent).not.toHaveProperty('accepted');
  });
});

describe('x402 — a resubmitted header whose authorization already settled', () => {
  // 2026-10-16: an agent re-sent a USA₮ header that had just settled. Tether's revert for a spent
  // nonce is "TetherToken: auth invalid"; it was reported as a signature mismatch and the agent
  // was told nothing was charged.
  it("reads Tether's \"auth invalid\" as already used and answers from the existing row", async () => {
    receipts[SETTLE_TX] = settledReceipt();
    await pay();
    db.tables.transactions[0].status = 'SUCCESS';
    simulateRevert = new Error('The contract function "transferWithAuthorization" reverted with the following reason:\nTetherToken: auth invalid');
    sendTelegramAlert.mockClear();
    const again = await pay();
    expect(again.json).toMatchObject({ status: 'SUCCESS', tx_hash: SETTLE_TX });
    expect(again.json.errorCode).toBeUndefined();
    expect(facilitatorCalls).toBe(1);
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlert.mock.calls.some(([t]) => String(t).includes('SIGNATURE REFUSED'))).toBe(false);
  });

  it('asks the token when a revert names nothing it recognises, and a spent nonce is not a bad signature', async () => {
    authStates[NONCE] = true;
    simulateRevert = new Error('execution reverted');
    db.tables.transactions.push({ id: 'prior', status: 'PROCESSING', tx_hash: SETTLE_TX, x402_payer: PAYER.toLowerCase(), x402_nonce: NONCE.toLowerCase() });
    const r = await pay();
    expect(r.json.errorCode).toBeUndefined();
    expect(r.json).toMatchObject({ status: 'TIMEOUT' });
    expect(facilitatorCalls).toBe(0);
  });

  it('still refuses a genuinely bad signature over an unspent nonce', async () => {
    authStates[NONCE] = false;
    simulateRevert = new Error('TetherToken: invalid signature');
    const r = await pay();
    expect(r.json.errorCode).toBe('SIGNATURE_MISMATCH');
    expect(facilitatorCalls).toBe(0);
    expect(db.tables.transactions).toHaveLength(0);
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

describe('/api/pay/x402 — Celo is the agent default, Base is offered after it', () => {
  // The endpoint is agent-facing: a caller that names no chain is answered on Celo, with each of
  // Celo's three stablecoins, then Base USDC. buy (Celo's marketplace CLI) pays only on Celo.
  const BASE_VAULT = '0xc0a4daa04ded9c54d1239507b5a5e645761ef488';
  const withBase = async <T>(fn: () => Promise<T>) => {
    process.env.CDP_API_KEY_ID = 'id';
    process.env.CDP_API_KEY_SECRET = 'secret';
    process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS = BASE_VAULT;
    try { return await fn(); } finally {
      delete process.env.CDP_API_KEY_ID;
      delete process.env.CDP_API_KEY_SECRET;
      delete process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS;
    }
  };
  // The bill as a generic x402 client sends it: no chain, no token.
  const unnamed: Partial<typeof bill> = { ...bill };
  delete unnamed.blockchain;
  delete unnamed.token;
  type Accept = { network: string; asset: string; payTo: string; maxAmountRequired: string; extra: { name: string } };

  it('a bare probe gets Celo USDC, USD₮ and USA₮ first, then Base USDC, all at one price', async () => {
    const { accepts } = await withBase(async () => (await GET(new Request('http://localhost/api/pay/x402'))).json()) as { accepts: Accept[] };
    expect(accepts.map((a) => a.network)).toEqual(['eip155:42220', 'eip155:42220', 'eip155:42220', 'eip155:8453']);
    expect(accepts.slice(0, 3).map((a) => a.extra.name)).toEqual(['USDC', 'Tether USD', 'Tether America USD']);
    expect(accepts.slice(0, 3).every((a) => a.payTo === CELO_VAULT)).toBe(true);
    expect(accepts[3]).toMatchObject({ payTo: BASE_VAULT, extra: { name: 'USD Coin' } });
    expect(new Set(accepts.map((a) => a.maxAmountRequired)).size).toBe(1);
  });

  it('without Base configured, a bare probe still offers all three Celo stablecoins', async () => {
    const { accepts } = await (await GET(new Request('http://localhost/api/pay/x402'))).json() as { accepts: Accept[] };
    expect(accepts.map((a) => a.extra.name)).toEqual(['USDC', 'Tether USD', 'Tether America USD']);
  });

  it('a caller that names a chain gets exactly that one entry', async () => {
    const r = await withBase(() => pay(bill, null));
    expect(r.json.accepts.map((a: Accept) => a.network)).toEqual(['eip155:42220']);
  });

  it('a paid retry that names no chain settles on Celo, the chain its header signed', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    const r = await withBase(() => pay(unnamed, header()));
    expect(r.json.status).toBe('SUCCESS');
    expect(facilitatorCalls).toBe(1);
    expect(db.tables.transactions[0]).toMatchObject({ blockchain: 'CELO', token_used: 'USDC' });
  });

  it('a v2 retry that names no token settles in the token it signed (USD₮)', async () => {
    const usdt = CELO_TOKENS['USD₮'].address;
    const flat = JSON.parse(Buffer.from(header(), 'base64').toString());
    const v2 = Buffer.from(JSON.stringify({ ...flat, accepted: { network: 'eip155:42220', asset: usdt } })).toString('base64');
    receipts[SETTLE_TX] = { status: 'success', logs: [transferLog({ token: usdt, from: PAYER, to: CELO_VAULT, value: BigInt(1_000_000) })] };
    const r = await pay(unnamed, v2);
    expect(r.json.status).toBe('SUCCESS');
    expect(db.tables.transactions[0]).toMatchObject({ blockchain: 'CELO', token_used: 'USD₮' });
  });
});

// 2026-10-26: a MiniPay postpaid Ibadan meter was refunded as "not a valid NMD meter" with no
// purchase ever reaching VTpass. The web app sends prepaid/postpaid as variation_code and the
// VTpass account class ("NMD") as meter_account_type; the route verified with "NMD" as the type.
describe('/api/pay/x402 — electricity meter type', () => {
  const electricity = { ...bill, serviceID: 'ibadan-electric', serviceCategory: 'ELECTRICITY', network: 'IBADAN-ELECTRIC', billersCode: '45012345678', nairaAmount: '1340' }; // 1 USDC at the mocked rate

  it('web app shape: verifies and vends as postpaid, not as the NMD account class', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    await pay({ ...electricity, variation_code: 'postpaid', meter_account_type: 'NMD' });
    expect(verifyAccount).toHaveBeenCalledWith('ibadan-electric', '45012345678', 'postpaid');
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(executeVend.mock.calls[0][0]).toMatchObject({ variation_code: 'postpaid' });
  });

  it('agent/SDK shape: meter_account_type alone becomes the vend variation_code', async () => {
    receipts[SETTLE_TX] = settledReceipt();
    const noVariation: Record<string, unknown> = { ...electricity }; delete noVariation.variation_code;
    await pay({ ...noVariation, meter_account_type: 'prepaid' });
    expect(verifyAccount).toHaveBeenCalledWith('ibadan-electric', '45012345678', 'prepaid');
    expect(executeVend.mock.calls[0][0]).toMatchObject({ variation_code: 'prepaid' });
  });
});
