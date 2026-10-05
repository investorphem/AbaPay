import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ executeVend — the ambiguous provider outcomes (ABAPAY_FULL_AUDIT.md P-4 / B-7).
//
// A /pay that never answers, and an order VTpass accepted but hasn't delivered, are NOT
// successes and NOT failures. Both must leave the row PROCESSING — no second order, no refund,
// no "delivered" — for the requery sweep (src/lib/reconcileStuck.ts) to resolve.

vi.mock('server-only', () => ({}));

let db: FakeDb;
let vtpass: (() => Response | Promise<Response>) | null = null;
const enqueueRefund = vi.fn(async () => ({ queued: true }));

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {} }));
const sms: string[] = [];
const emails: { to: string; subject: string }[] = [];
let lastPayload: Record<string, unknown> = {};
const bankTransfer = vi.fn<(...a: unknown[]) => Promise<{ success: boolean; status: string }>>(async () => ({ success: true, status: 'TIMEOUT' }));
vi.mock('@/lib/messaging', () => ({ sendAbaPaySms: async (_to: string, m: string) => { sms.push(m); } }));
vi.mock('@/lib/vtpass', () => ({ getHeaders: () => ({}) }));
vi.mock('@/lib/refunds', () => ({ enqueueRefund: () => enqueueRefund() }));
vi.mock('@/lib/monnifyVend', () => ({ initiateMonnifyBankTransfer: (...a: unknown[]) => bankTransfer(...a) }));
vi.mock('@/lib/balanceAlerts', () => ({ checkProviderBalances: async () => ({ ok: true }) }));
vi.mock('resend', () => ({ Resend: class { emails = { send: async (e: { to: string; subject: string }) => { emails.push({ to: e.to, subject: e.subject }); return {}; } }; } }));
const tripCircuit = vi.fn(async (_p: string, _r: string) => {});
vi.mock('@/lib/circuitBreaker', () => ({ tripCircuit: (p: string, r: string) => tripCircuit(p, r) }));

vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (!String(url).endsWith('/pay')) throw new Error(`unexpected fetch ${url}`);
  lastPayload = JSON.parse(String(init?.body || '{}'));
  if (!vtpass) throw new Error('no VTpass stub');
  return vtpass();
});

const { executeVend } = await import('@/lib/vend');

const TX = '0x' + 'a'.repeat(64);
function input() {
  return {
    vtRequestId: '202609291200vend000001', txHash: TX, serviceID: 'mtn', serviceCategory: 'AIRTIME', network: 'MTN',
    billersCode: '08012345678', phone: '08012345678', amount: 1, tokenSymbol: 'USDC', vendAmount: 1340,
    isForeign: false, wallet_address: '0xabc', blockchain: 'CELO', baseRate: 1340, explorerUrl: 'https://x',
  };
}
const rowNow = () => db.tables.transactions[0];

beforeEach(() => {
  db = createFakeDb({ transactions: [{ id: 'r1', tx_hash: TX, status: 'PROCESSING', request_id: '202609291200vend000001' }] });
  vtpass = null;
  enqueueRefund.mockClear();
  bankTransfer.mockClear();
  sms.length = 0; emails.length = 0; lastPayload = {};
});

describe('executeVend dispatch guard (M6)', () => {
  it('two concurrent deliveries of the same payment call VTpass once', async () => {
    let calls = 0;
    vtpass = () => { calls++; return new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } })); };
    const [a, b] = await Promise.all([executeVend(input()), executeVend(input())]);
    expect(calls).toBe(1);
    expect([a.message, b.message]).toContain('This payment is already being delivered.');
    expect(rowNow().vend_dispatched_at).toBeTruthy();
  });

  it('never re-sends a payment already dispatched', async () => {
    db.tables.transactions[0].vend_dispatched_at = new Date().toISOString();
    let calls = 0;
    vtpass = () => { calls++; return new Response('{}'); };
    const r = await executeVend(input());
    expect(calls).toBe(0);
    expect(r.status).toBe('TIMEOUT');
  });

  it('a payment with no matching row still delivers (the guard never blocks a first delivery)', async () => {
    db.tables.transactions = [];
    let calls = 0;
    vtpass = () => { calls++; return new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } })); };
    await executeVend(input());
    expect(calls).toBe(1);
  });
});

describe('executeVend', () => {
  it('keeps the row PROCESSING when VTpass never answers — no reset to PENDING, no refund', async () => {
    vtpass = () => { throw new Error('ETIMEDOUT'); };
    const r = await executeVend(input());
    expect(r.status).toBe('TIMEOUT');
    expect(rowNow()).toMatchObject({ status: 'PROCESSING', error_code: 'PROVIDER_NO_RESPONSE', request_id: '202609291200vend000001' });
    expect(enqueueRefund).not.toHaveBeenCalled();
  });

  it('keeps a non-JSON /pay answer PROCESSING too', async () => {
    vtpass = () => new Response('<html>502</html>', { status: 502 });
    await executeVend(input());
    expect(rowNow()).toMatchObject({ status: 'PROCESSING', error_code: 'PROVIDER_NO_RESPONSE' });
  });

  it('does not call 099 (accepted, processing) a success', async () => {
    vtpass = () => Response.json({ code: '099', content: { transactions: { status: 'pending' } } });
    const r = await executeVend(input());
    expect(r.status).toBe('TIMEOUT');
    expect(rowNow()).toMatchObject({ status: 'PROCESSING', error_code: 'PROVIDER_PENDING' });
  });

  it('does not call 000 with a pending status a success', async () => {
    vtpass = () => Response.json({ code: '000', content: { transactions: { status: 'initiated' } } });
    await executeVend(input());
    expect(rowNow()).toMatchObject({ status: 'PROCESSING', error_code: 'PROVIDER_PENDING' });
  });

  it('still records a delivered 000 as SUCCESS', async () => {
    vtpass = () => Response.json({ code: '000', content: { transactions: { status: 'delivered', transactionId: 't1' } } });
    const r = await executeVend(input());
    expect(r.status).toBe('SUCCESS');
    expect(rowNow()).toMatchObject({ status: 'SUCCESS' });
  });

  it('still records a 000 with no status as SUCCESS, exactly as before', async () => {
    vtpass = () => Response.json({ code: '000', content: {} });
    expect((await executeVend(input())).status).toBe('SUCCESS');
  });

  it('still fails and queues a refund on a definite rejection', async () => {
    vtpass = () => Response.json({ code: '018', response_description: 'LOW WALLET BALANCE' });
    const r = await executeVend(input());
    expect(r.status).toBe('FAILED_VENDING');
    expect(rowNow()).toMatchObject({ status: 'FAILED_VENDING', error_code: '018' });
    expect(enqueueRefund).toHaveBeenCalledTimes(1);
    // …and pauses VTpass sales so the NEXT payer isn't charged for the same failure.
    expect(tripCircuit).toHaveBeenCalledWith('VTPASS', expect.stringContaining('018'));
  });

  it('does not trip the breaker on an ordinary rejection', async () => {
    tripCircuit.mockClear();
    vtpass = () => Response.json({ code: '011', response_description: 'INVALID ARGUMENTS' });
    await executeVend(input());
    expect(tripCircuit).not.toHaveBeenCalled();
  });
});

// M7: what each kind of bill actually sends VTpass, and what the customer gets back.
describe('executeVend per service', () => {
  const delivered = (extra: Record<string, unknown> = {}) => () =>
    new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } }, ...extra }));

  it('a DStv plan change sends the subscription type, plan and quantity', async () => {
    vtpass = delivered();
    await executeVend({ ...input(), serviceID: 'dstv', serviceCategory: 'CABLE', billersCode: '7012345678', subscription_type: 'change', variation_code: 'dstv-padi' });
    expect(lastPayload).toMatchObject({ serviceID: 'dstv', billersCode: '7012345678', subscription_type: 'change', variation_code: 'dstv-padi', quantity: 1 });
  });

  it('a DStv renewal sends no plan', async () => {
    vtpass = delivered();
    await executeVend({ ...input(), serviceID: 'dstv', serviceCategory: 'CABLE', billersCode: '7012345678', subscription_type: 'renew', variation_code: 'dstv-padi' });
    expect(lastPayload.subscription_type).toBe('renew');
    expect(lastPayload.variation_code).toBeUndefined();
  });

  it('Startimes sends the plan directly', async () => {
    vtpass = delivered();
    await executeVend({ ...input(), serviceID: 'startimes', serviceCategory: 'CABLE', billersCode: '0212345678', variation_code: 'nova' });
    expect(lastPayload).toMatchObject({ variation_code: 'nova' });
    expect(lastPayload.subscription_type).toBeUndefined();
  });

  it('prepaid electricity: the token is pulled from the reply, stored, texted and emailed', async () => {
    vtpass = delivered({ purchased_code: 'Token : 1234-5678-9012-3456-7890', units: 42.1 });
    const r = await executeVend({ ...input(), serviceID: 'ikeja-electric', serviceCategory: 'ELECTRICITY', billersCode: '45012345678', variation_code: 'prepaid', email: 'payer@example.com' });
    expect(lastPayload).toMatchObject({ billersCode: '45012345678', variation_code: 'prepaid' });
    expect(r).toMatchObject({ status: 'SUCCESS', units: '42.1' });
    expect(rowNow()).toMatchObject({ status: 'SUCCESS', units: '42.1' });
    expect(String(rowNow().purchased_code).replace(/\D/g, '')).toBe('12345678901234567890');
    expect(sms).toHaveLength(1);
    expect(emails).toEqual([expect.objectContaining({ to: 'payer@example.com' })]);
  });

  it('postpaid electricity gets no SMS (there is no token)', async () => {
    vtpass = delivered();
    await executeVend({ ...input(), serviceID: 'ikeja-electric', serviceCategory: 'ELECTRICITY', billersCode: '45012345678', variation_code: 'postpaid' });
    expect(sms).toHaveLength(0);
  });

  it('a WAEC PIN is stored and texted', async () => {
    vtpass = delivered({ purchased_code: 'Serial No:WRN123, pin: 0987654321' });
    const r = await executeVend({ ...input(), serviceID: 'waec', serviceCategory: 'EDUCATION', variation_code: 'waecdirect' });
    expect(r.purchased_code).toBeTruthy();
    expect(lastPayload.billersCode).toBeUndefined();
    expect(sms).toHaveLength(1);
  });

  it('JAMB sends the profile code', async () => {
    vtpass = delivered({ Pin: '1234567890' });
    await executeVend({ ...input(), serviceID: 'jamb', serviceCategory: 'EDUCATION', billersCode: '0123456789', variation_code: 'utme' });
    expect(lastPayload).toMatchObject({ billersCode: '0123456789', variation_code: 'utme' });
  });

  it('Spectranet sends a quantity', async () => {
    vtpass = delivered();
    await executeVend({ ...input(), serviceID: 'spectranet', serviceCategory: 'INTERNET', billersCode: '08011111111', variation_code: 'spec-7' });
    expect(lastPayload).toMatchObject({ quantity: 1, variation_code: 'spec-7' });
  });

  it('international airtime sends the operator, country and foreign amount', async () => {
    vtpass = delivered();
    await executeVend({ ...input(), serviceID: 'foreign-airtime', isForeign: true, foreignAmount: '5', operator_id: 12, country_code: 'GH', product_type_id: 1, billersCode: '233201234567' });
    expect(lastPayload).toMatchObject({ amount: 5, operator_id: '12', country_code: 'GH', product_type_id: '1', billersCode: '233201234567' });
  });

  it('a bank transfer goes to Monnify, never to VTpass', async () => {
    vtpass = () => { throw new Error('VTpass must not be called for BANK'); };
    await executeVend({ ...input(), serviceCategory: 'BANK' });
    expect(bankTransfer).toHaveBeenCalledTimes(1);
  });
});
