import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';
import { CELO_TOKENS, OTHER_CONTRACT, fakeClient, hash, transferLog, type FakeReceipt } from './helpers/chain';

// M7: the refund pipeline. A refund is money leaving the vault, so the rules that matter are
// "never queue one for a payment that didn't land", "never record one as paid without the
// on-chain proof", and "one payout can't settle two debts".

let db: FakeDb;
let receipts: Record<string, FakeReceipt | Error> = {};
const alerts: string[] = [];
const dms: { chat: string; msg: string }[] = [];
const emails: { to: string; subject: string }[] = [];

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({
  sendTelegramAlert: async (m: string) => { alerts.push(m); },
  sendTelegramToUser: async (chat: string, msg: string) => { dms.push({ chat, msg }); },
}));
vi.mock('resend', () => ({
  Resend: class { emails = { send: async (e: { to: string; subject: string }) => { emails.push({ to: e.to, subject: e.subject }); return {}; } }; },
}));
vi.mock('@/lib/chain', async (orig) => ({
  ...(await orig<typeof import('@/lib/chain')>()),
  getPublicClient: () => fakeClient(receipts),
}));

beforeAll(() => { process.env.NEXT_PUBLIC_NETWORK = 'celo'; });

const { enqueueRefund } = await import('@/lib/refunds');
const { verifyRefundOnChain, refundHashAlreadyUsed, completeRefund, rememberRefundHash, reconcileRecordedRefunds } = await import('@/lib/refundVerify');

const WALLET = '0x3333333333333333333333333333333333333333';
const PAY_TX = hash(10);
const REFUND_TX = hash(20);
const usdt = CELO_TOKENS['USD₮'];
const paid = (amount: string, opts: { to?: string; token?: string } = {}): FakeReceipt => ({
  status: 'success',
  logs: [transferLog({ token: opts.token ?? usdt.address, from: OTHER_CONTRACT, to: opts.to ?? WALLET, value: parseUnits(amount, 6) })],
});

beforeEach(() => {
  alerts.length = 0; dms.length = 0; emails.length = 0;
  receipts = {};
  db = createFakeDb({
    transactions: [{ id: 't1', tx_hash: PAY_TX, status: 'FAILED_VENDING', customer_email: 'payer@example.com' }],
    agent_links: [{ wallet_address: WALLET, channel: 'TELEGRAM', channel_user_id: '42', link_verified: true }],
    refund_queue: [],
  });
  db.unique.refund_queue = ['tx_hash'];
});

const params = { txHash: PAY_TX, walletAddress: WALLET.toUpperCase().replace('0X', '0x'), tokenUsed: 'USD₮', amountCrypto: 2, amountNaira: 2680, reason: 'vend failed', serviceCategory: 'AIRTIME' };

describe('enqueueRefund', () => {
  it('queues a refund, alerts the operator and tells the user on their channel and by email', async () => {
    expect(await enqueueRefund(params)).toEqual({ queued: true });
    expect(db.tables.refund_queue).toHaveLength(1);
    expect(db.tables.refund_queue[0]).toMatchObject({ status: 'PENDING', wallet_address: WALLET, blockchain: 'CELO', source_channel: 'WEB' });
    expect(alerts[0]).toMatch(/REFUND QUEUED/);
    expect(dms).toEqual([expect.objectContaining({ chat: '42' })]);
    expect(emails).toEqual([expect.objectContaining({ to: 'payer@example.com' })]);
  });

  it('never queues a refund for a preflight (no money moved)', async () => {
    expect((await enqueueRefund({ ...params, txHash: 'preflight_abc' })).queued).toBe(false);
    expect(db.tables.refund_queue).toHaveLength(0);
  });

  it('refuses incomplete or zero amounts', async () => {
    expect((await enqueueRefund({ ...params, amountCrypto: 0 })).queued).toBe(false);
    expect((await enqueueRefund({ ...params, walletAddress: '' })).queued).toBe(false);
    expect(db.tables.refund_queue).toHaveLength(0);
  });

  it('is idempotent per payment: a retrying webhook does not queue twice', async () => {
    await enqueueRefund(params);
    expect(await enqueueRefund(params)).toEqual({ queued: false, reason: 'Already queued.' });
    expect(db.tables.refund_queue).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('the customer message never carries the admin-only provider detail', async () => {
    await enqueueRefund({ ...params, vtpassError: 'code 018: low wallet balance', userMessage: 'The provider could not complete it.' });
    expect(alerts[0]).toContain('018');
    expect(dms[0].msg).not.toContain('018');
  });
});

describe('verifyRefundOnChain', () => {
  const claim = { blockchain: 'CELO', tokenUsed: 'USD₮', walletAddress: WALLET, amountCrypto: 2, refundTxHash: REFUND_TX };

  it('VERIFIED when the right token reached the right wallet', async () => {
    receipts[REFUND_TX] = paid('2');
    expect(await verifyRefundOnChain(claim)).toEqual({ status: 'VERIFIED' });
  });

  it('allows one cent of rounding, no more', async () => {
    receipts[REFUND_TX] = paid('1.995');
    expect((await verifyRefundOnChain(claim)).status).toBe('VERIFIED');
    receipts[REFUND_TX] = paid('1.98');
    expect((await verifyRefundOnChain(claim)).status).toBe('MISMATCH');
  });

  it('MISMATCH for another recipient or another token', async () => {
    receipts[REFUND_TX] = paid('2', { to: OTHER_CONTRACT });
    expect((await verifyRefundOnChain(claim)).status).toBe('MISMATCH');
    receipts[REFUND_TX] = paid('2', { token: CELO_TOKENS.USDC.address });
    expect((await verifyRefundOnChain(claim)).status).toBe('MISMATCH');
  });

  it('REVERTED when the transaction failed', async () => {
    receipts[REFUND_TX] = { status: 'reverted', logs: [] };
    expect((await verifyRefundOnChain(claim)).status).toBe('REVERTED');
  });

  it('UNCONFIRMED (keep the hash) when it is not mined yet', async () => {
    expect((await verifyRefundOnChain(claim, 1000)).status).toBe('UNCONFIRMED');
  });
});

describe('completeRefund / rememberRefundHash', () => {
  beforeEach(() => {
    db.tables.refund_queue.push({ id: 'r1', tx_hash: PAY_TX, wallet_address: WALLET, token_used: 'USD₮', amount_crypto: 2, blockchain: 'CELO', status: 'PENDING' });
  });

  it('completes the queue row and the ledger and tells the user once', async () => {
    const refund = { ...db.tables.refund_queue[0] };
    expect(await completeRefund(refund, REFUND_TX)).toBe(true);
    expect(db.tables.refund_queue[0]).toMatchObject({ status: 'COMPLETED', refund_tx_hash: REFUND_TX, user_notified: true });
    expect(db.tables.transactions[0]).toMatchObject({ status: 'REFUNDED', refund_hash: REFUND_TX });
    expect(dms).toHaveLength(1);
    // A sweep racing the operator's click: no second notification.
    expect(await completeRefund(refund, REFUND_TX)).toBe(false);
    expect(dms).toHaveLength(1);
  });

  it('remembering a hash leaves the refund owed', async () => {
    await rememberRefundHash('r1', REFUND_TX);
    expect(db.tables.refund_queue[0]).toMatchObject({ status: 'PENDING', refund_tx_hash: REFUND_TX });
  });

  it('a hash already banked against another refund is detected', async () => {
    db.tables.refund_queue.push({ id: 'r0', refund_tx_hash: REFUND_TX, status: 'COMPLETED' });
    expect(await refundHashAlreadyUsed(REFUND_TX, 'r1')).toBe(true);
    expect(await refundHashAlreadyUsed(REFUND_TX, 'r0')).toBe(false);
  });
});

describe('reconcileRecordedRefunds', () => {
  const pending = (id: string, txHash: string, refundTxHash: string) =>
    ({ id, tx_hash: txHash, wallet_address: WALLET, token_used: 'USD₮', amount_crypto: 2, blockchain: 'CELO', status: 'PENDING', refund_tx_hash: refundTxHash });

  it('completes confirmed refunds, clears reverted hashes and escalates mismatches', async () => {
    const [ok, dead, wrong, waiting] = [hash(31), hash(32), hash(33), hash(34)];
    receipts[ok] = paid('2');
    receipts[dead] = { status: 'reverted', logs: [] };
    receipts[wrong] = paid('2', { to: OTHER_CONTRACT });
    db.tables.refund_queue.push(pending('a', PAY_TX, ok), pending('b', hash(11), dead), pending('c', hash(12), wrong), pending('d', hash(13), waiting));

    const r = await reconcileRecordedRefunds({ force: true });
    expect(r).toMatchObject({ ok: true, completed: 1, cleared: 1, stillPending: 2 });
    const byId = Object.fromEntries(db.tables.refund_queue.map((x) => [x.id, x]));
    expect(byId.a.status).toBe('COMPLETED');
    expect(byId.b).toMatchObject({ status: 'PENDING', refund_tx_hash: null });
    expect(byId.c).toMatchObject({ status: 'PENDING', refund_tx_hash: wrong });
    expect(byId.d).toMatchObject({ status: 'PENDING', refund_tx_hash: waiting });
    expect(alerts.some((a) => /DOESN'T MATCH/.test(a))).toBe(true);
  });

  it('one payout cannot settle two refunds', async () => {
    receipts[REFUND_TX] = paid('2');
    db.tables.refund_queue.push({ ...pending('done', PAY_TX, REFUND_TX), status: 'COMPLETED' }, pending('twin', hash(14), REFUND_TX));
    const r = await reconcileRecordedRefunds({ force: true });
    expect(r).toMatchObject({ completed: 0, stillPending: 1 });
    expect(db.tables.refund_queue.find((x) => x.id === 'twin')!.status).toBe('PENDING');
    expect(alerts.some((a) => /USED TWICE/.test(a))).toBe(true);
  });

  it('is rate-limited unless forced', async () => {
    await reconcileRecordedRefunds({ force: true });
    expect(await reconcileRecordedRefunds()).toMatchObject({ skipped: true });
  });
});
