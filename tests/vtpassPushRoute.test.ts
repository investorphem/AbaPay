import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// M7: /api/webhook/vtpass, the push VTpass sends when an order settles late. The push is
// unauthenticated, so the route must act only on what an authenticated requery says, always
// acknowledge with {"response":"success"}, and never deliver twice or deliver over a refund.

vi.mock('server-only', () => ({}));

let db: FakeDb;
let requery: Record<string, unknown> | Error = {};
let pending: (() => Promise<void>) | null = null;
const alerts: string[] = [];
const sms: { to: string; msg: string }[] = [];
const emails: { to: string; subject: string }[] = [];
const enqueueRefund = vi.fn<(p: { txHash: string }) => Promise<{ queued: boolean }>>(async (p) => {
  const exists = db.tables.refund_queue.some((r) => r.tx_hash === p.txHash);
  if (!exists) db.tables.refund_queue.push({ id: `rq-${p.txHash}`, tx_hash: p.txHash, status: 'PENDING', refund_tx_hash: null });
  return { queued: !exists };
});
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
  if (requery instanceof Error) throw requery;
  return new Response(JSON.stringify(requery));
});

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => { pending = fn; },
}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (m: string) => { alerts.push(m); } }));
vi.mock('@/lib/messaging', () => ({ sendAbaPaySms: async (to: string, msg: string) => { sms.push({ to, msg }); } }));
vi.mock('@/lib/vtpass', () => ({ getHeaders: () => ({}) }));
vi.mock('@/lib/refunds', () => ({ enqueueRefund: (p: { txHash: string }) => enqueueRefund(p) }));
vi.mock('@/lib/receiptEmail', () => ({ buildReceiptEmail: () => '<p>receipt</p>' }));
vi.mock('resend', () => ({
  Resend: class { emails = { send: async (e: { to: string; subject: string }) => { emails.push({ to: e.to, subject: e.subject }); return {}; } }; },
}));
vi.stubGlobal('fetch', fetchMock);

const { POST } = await import('@/app/api/webhook/vtpass/route');

const RID = '202610051200push000001';
/** POST a push, check the acknowledgement, then run the deferred work. */
async function push(body: unknown) {
  pending = null;
  const res = await POST(new Request('http://localhost/api/webhook/vtpass', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  expect(await res.json()).toEqual({ response: 'success' });
  if (pending) await (pending as () => Promise<void>)();
}
const confirmed = (status: string, extra: Record<string, unknown> = {}) => {
  requery = { code: '000', content: { transactions: { status, ...(extra.tx as object || {}) } }, ...extra };
};
function row(over: Record<string, unknown> = {}) {
  const r = {
    id: 'r1', tx_hash: '0xpaid', request_id: RID, status: 'PROCESSING', amount_usdt: 1, amount_naira: 2000,
    wallet_address: '0xWALLET', token_used: 'USDC', blockchain: 'CELO', account_number: '08012345678', phone: '08012345678',
    network: 'MTN', service_category: 'AIRTIME', service_id: 'mtn', customer_email: null,
    ...over,
  };
  db.tables.transactions.push(r);
  return r;
}
const rowNow = () => db.tables.transactions[0];

beforeEach(() => {
  db = createFakeDb({ transactions: [], refund_queue: [] });
  db.rpcHandlers = { award_transaction_points: () => ({ data: null, error: null }) };
  requery = {};
  alerts.length = 0; sms.length = 0; emails.length = 0;
  enqueueRefund.mockClear(); fetchMock.mockClear();
});

describe('VTpass push acknowledgement', () => {
  it('acknowledges an unparseable body and does nothing', async () => {
    await push('not json{');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acknowledges a push with no requestId and does nothing', async () => {
    await push({ type: 'transaction-update' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a push for an order we never created', async () => {
    await push({ data: { requestId: 'nope' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('VTpass push: never trust the payload', () => {
  it('a forged "delivered" push is checked by requery, and a pending answer changes nothing', async () => {
    row();
    confirmed('pending');
    await push({ data: { requestId: RID, content: { transactions: { status: 'delivered' } } } });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/requery$/);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ request_id: RID });
    expect(rowNow().status).toBe('PROCESSING');
    expect(alerts).toHaveLength(0);
  });

  it('if the requery itself fails, the push is ignored', async () => {
    row();
    requery = new Error('network down');
    await push({ requestId: RID });
    expect(rowNow().status).toBe('PROCESSING');
    expect(enqueueRefund).not.toHaveBeenCalled();
  });

  it('a forged "reversed" push on a delivered order is ignored when VTpass says delivered', async () => {
    row({ status: 'SUCCESS' });
    confirmed('delivered');
    await push({ requestId: RID, content: { transactions: { status: 'reversed' } } });
    expect(rowNow().status).toBe('SUCCESS');
    expect(enqueueRefund).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });
});

describe('VTpass push: late delivery', () => {
  it('records the delivery, alerts once, and awards points', async () => {
    row();
    confirmed('delivered');
    await push({ requestId: RID });
    expect(rowNow().status).toBe('SUCCESS');
    expect(alerts).toEqual([expect.stringContaining('DELAYED SALE SUCCESS')]);
    expect(sms).toHaveLength(0); // airtime has no token to text
  });

  it('a re-push of the same delivery sends nothing a second time', async () => {
    row();
    confirmed('delivered');
    await push({ requestId: RID });
    await push({ requestId: RID });
    expect(alerts).toHaveLength(1);
  });

  it('prepaid electricity: the token comes from the confirmed reply and is texted and emailed', async () => {
    row({ service_category: 'ELECTRICITY', service_id: 'ikeja-electric', variation_code: 'prepaid', network: 'IKEDC', customer_email: 'payer@example.com' });
    confirmed('delivered', { purchased_code: 'Token : 1111-2222-3333-4444-5555', units: 31.5 });
    await push({ requestId: RID, purchased_code: 'Token : 9999-9999-9999-9999-9999' });
    expect(String(rowNow().purchased_code).replace(/\D/g, '')).toBe('11112222333344445555');
    expect(rowNow().units).toBe('31.5');
    expect(sms).toEqual([expect.objectContaining({ to: '08012345678' })]);
    expect(sms[0].msg).toContain('Token');
    expect(emails).toEqual([expect.objectContaining({ to: 'payer@example.com' })]);
  });

  it('never flips a refunded order to delivered', async () => {
    row({ status: 'FAILED_VENDING' });
    db.tables.refund_queue.push({ id: 'q1', tx_hash: '0xpaid', status: 'COMPLETED', refund_tx_hash: '0xrefund' });
    confirmed('delivered');
    await push({ requestId: RID });
    expect(rowNow().status).not.toBe('SUCCESS');
    expect(sms).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });
});

describe('VTpass push: late failure', () => {
  it('an in-flight order that VTpass failed is moved to FAILED_VENDING and a refund is queued', async () => {
    row();
    confirmed('failed', { response_description: 'TRANSACTION FAILED' });
    await push({ requestId: RID });
    expect(rowNow().status).toBe('FAILED_VENDING');
    expect(enqueueRefund).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([expect.stringContaining('REVERSAL ALERT')]);
  });

  it('a delivered order that VTpass later reversed needs a refund', async () => {
    row({ status: 'SUCCESS' });
    confirmed('reversed');
    await push({ requestId: RID });
    expect(rowNow().status).toBe('REVERSED_NEEDS_REFUND');
    expect(enqueueRefund).toHaveBeenCalledTimes(1);
  });

  it('a repeated reversal push does not alert twice', async () => {
    row();
    confirmed('reversed');
    await push({ requestId: RID });
    await push({ requestId: RID });
    expect(alerts).toHaveLength(1);
    expect(db.tables.refund_queue).toHaveLength(1);
  });
});
