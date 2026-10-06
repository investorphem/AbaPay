import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { parseUnits } from 'viem';
import { CELO_VAULT, CELO_TOKENS, PAYER, celoPayment, fakeClient, hash, paymentReceivedLog, type FakeReceipt } from './helpers/chain';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ /api/webhook (Alchemy) — the background completer for the contract-call rail, now built
// on the shared verifier and executeVend (implementation plan M2.2). Events are HMAC-signed
// exactly as Alchemy signs them; the chain and VTpass are fakes.

vi.mock('server-only', () => ({}));

const SECRET = 'whsec_test';
process.env.ALCHEMY_CELO_WEBHOOK_SECRET = SECRET;
delete process.env.ALCHEMY_WEBHOOK_SECRET;
process.env.WEBHOOK_HEAD_START_MS = '0';
process.env.WEBHOOK_LOOKUP_RETRY_MS = '0';
process.env.NEXT_PUBLIC_NETWORK = 'celo';
process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = CELO_VAULT;

let db: FakeDb;
let receipts: Record<string, FakeReceipt | Error> = {};
const executeVend = vi.fn<(input: unknown) => Promise<{ success: boolean; status: string }>>(async () => ({ success: true, status: 'SUCCESS' }));
const sendTelegramAlert = vi.fn<(text: string) => Promise<void>>(async () => {});

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: (t: string) => sendTelegramAlert(t) }));
vi.mock('@/lib/vend', () => ({ executeVend: (i: unknown) => executeVend(i) }));
vi.mock('@/lib/cleanupPreflights', () => ({ cleanupStalePreflights: async () => ({ ok: true }) }));
vi.mock('@/lib/reconcileStuck', () => ({ reconcileStuckProcessing: async () => ({ ok: true }) }));
vi.mock('@/lib/refundVerify', () => ({ reconcileRecordedRefunds: async () => ({ ok: true }) }));
vi.mock('@/lib/reconcileX402', () => ({ reconcileX402Intents: async () => ({ ok: true }) }));
vi.mock('@/lib/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chain')>();
  return { ...actual, getPublicClient: () => fakeClient(receipts) };
});

const { POST } = await import('@/app/api/webhook/route');

function event(txHash: string, from = PAYER, secret = SECRET) {
  const raw = JSON.stringify({ event: { activity: [{ hash: txHash, fromAddress: from }] } });
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return POST(new Request('http://localhost/api/webhook', { method: 'POST', headers: { 'x-alchemy-signature': sig }, body: raw }));
}

let seq = 0;
function row(over: Record<string, unknown> = {}) {
  const r = {
    id: `row-${++seq}`, tx_hash: `preflight_${crypto.randomUUID()}`, status: 'PENDING', request_id: `202609291200web${seq}`,
    wallet_address: PAYER, blockchain: 'CELO', token_used: 'USDC', amount_usdt: 1, amount_naira: 1340, fee_naira: 0,
    service_id: 'mtn', service_category: 'AIRTIME', network: 'MTN', account_number: '08012345678', phone: '08012345678',
    created_at: new Date(Date.now() - seq * 1000).toISOString(),
    ...over,
  };
  db.tables.transactions.push(r);
  return r;
}

const TX = hash(900);
const goodReceipt = (): FakeReceipt => ({ status: 'success', logs: [celoPayment('USDC', '1.0', 'mtn', '08012345678')] });

beforeEach(() => {
  db = createFakeDb();
  receipts = {};
  executeVend.mockClear();
  sendTelegramAlert.mockClear();
});

describe('/api/webhook', () => {
  it('rejects a bad signature', async () => {
    const res = await event(TX, PAYER, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('fast-exits on activity that matches no record, without reading the chain', async () => {
    receipts[TX] = new Error('must not be read');
    const res = await event(TX);
    expect((await res.json()).message).toMatch(/No matching record/);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('rescues an intent whose request died: proves the payment, attaches the hash, vends once', async () => {
    const r = row();
    receipts[TX] = goodReceipt();
    await event(TX);
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(db.tables.transactions.find((t) => t.id === r.id)).toMatchObject({ tx_hash: TX, status: 'PROCESSING' });
  });

  it('picks the intent this payment actually matches when the wallet has several open', async () => {
    const other = row({ account_number: '08099999999' }); // most recent, but a different bill
    const mine = row();
    receipts[TX] = goodReceipt();
    await event(TX);
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(db.tables.transactions.find((t) => t.id === mine.id)).toMatchObject({ tx_hash: TX, status: 'PROCESSING' });
    expect(db.tables.transactions.find((t) => t.id === other.id)).toMatchObject({ status: 'PENDING' });
  });

  it('leaves an open intent ALONE when an unrelated transaction from the same wallet arrives', async () => {
    const r = row();
    receipts[TX] = { status: 'success', logs: [] }; // e.g. a refund landing — no vault event
    await event(TX);
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.transactions.find((t) => t.id === r.id)).toMatchObject({ status: 'PENDING', tx_hash: r.tx_hash });
  });

  it('ATTACK: refuses USDm dust against a USDC row matched by hash', async () => {
    const r = row({ tx_hash: TX });
    receipts[TX] = { status: 'success', logs: [paymentReceivedLog({ token: CELO_TOKENS.USDm.address, serviceType: 'mtn', accountNumber: '08012345678', amountWei: parseUnits('1', 6) })] };
    await event(TX);
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.transactions.find((t) => t.id === r.id)).toMatchObject({ status: 'FAILED_VENDING', error_code: 'TOKEN_MISMATCH' });
  });

  it('marks an underpaid row matched by hash as AMOUNT_MISMATCH', async () => {
    const r = row({ tx_hash: TX });
    receipts[TX] = { status: 'success', logs: [celoPayment('USDC', '0.5', 'mtn', '08012345678')] };
    await event(TX);
    expect(db.tables.transactions.find((t) => t.id === r.id)).toMatchObject({ status: 'FAILED_VENDING', error_code: 'AMOUNT_MISMATCH' });
  });

  it('does nothing for a row already past PENDING', async () => {
    row({ tx_hash: TX, status: 'SUCCESS' });
    receipts[TX] = goodReceipt();
    await event(TX);
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('ignores a recorded refund instead of failing the row that carries its hash', async () => {
    const r = row({ tx_hash: TX });
    row({ tx_hash: hash(901), status: 'REFUNDED', refund_hash: TX });
    receipts[TX] = { status: 'success', logs: [] };
    await event(TX);
    expect(db.tables.transactions.find((t) => t.id === r.id)).toMatchObject({ status: 'PENDING' });
  });

  it('leaves the row PENDING when the chain cannot be read', async () => {
    const r = row({ tx_hash: TX });
    receipts[TX] = new Error('socket hang up');
    await event(TX);
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.transactions.find((t) => t.id === r.id)).toMatchObject({ status: 'PENDING' });
  });

  it('never rescues an x402 intent (its settlement has no vault event)', async () => {
    const x = row({ tx_hash: `preflight_x402_CELO_${PAYER}_${hash(5)}` });
    receipts[TX] = { status: 'success', logs: [] };
    await event(TX);
    expect(db.tables.transactions.find((t) => t.id === x.id)).toMatchObject({ status: 'PENDING', tx_hash: x.tx_hash });
  });
});
