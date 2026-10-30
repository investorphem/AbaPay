import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// /api/pay/nim — creating an order. An incomplete order is refused before anything is written
// or charged, and a request's loose spelling (lower-case category, no network) is normalised the
// way every other rail stores it. 2026-10-17: a "data" order with no network hit the
// transactions NOT NULL, answered 500 and raised "NIM INTENT WRITE FAILED".

vi.mock('server-only', () => ({}));

let db: FakeDb;
const alerts: string[] = [];
const gateCalls: Record<string, unknown>[] = [];
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (t: string) => { alerts.push(t); } }));
vi.mock('@/lib/vend', () => ({ getStrictRequestId: () => '202610171200nim0000001' }));
let nimDiscount = { enabled: false, percent: 0 };
vi.mock('@/lib/nimDiscount', () => ({ getNimDiscount: async () => nimDiscount }));
// abapays.com's campaigns must never reach a NIM order: if the route asked them, this throws.
vi.mock('@/lib/discounts', () => ({
  getActiveDiscountForService: async () => { throw new Error('NIM orders must not use discount campaigns'); },
  computeDiscountNgn: async () => { throw new Error('NIM orders must not use discount campaigns'); },
}));
vi.mock('@/lib/parity', () => ({ isDuplicateElectricity: async () => false }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
let offCategories: string[] = [];
vi.mock('@/lib/serviceRules', () => ({ checkWebPayment: async (a: Record<string, unknown>) => {
  gateCalls.push(a);
  return offCategories.includes(String(a.serviceCategory)) ? { allowed: false, code: 'SERVICE_UNAVAILABLE', reason: 'Switched off. Nothing was charged.' } : { allowed: true };
} }));
vi.mock('@/lib/billCharges', () => ({ billCharges: () => ({ serviceFee: 0, stampDutyNgn: 0 }) }));
vi.mock('@/lib/nimSettle', () => ({ NIM_INTENT_PREFIX: 'nim_intent_', settleNimIntent: async () => ({}) }));
vi.mock('@/lib/nimiq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nimiq')>();
  return { ...actual, treasuryAddress: () => 'NQ36 8QDJ 26LU ABEG 3E84 14NT 4HBB 91GC 36P3', nimUsdPrice: async () => 0.001, nimBalanceLuna: async () => balanceLuna };
});

let balanceLuna: number | null = null;
const { POST, GET } = await import('@/app/api/pay/nim/route');
const PAYER = 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG';

const order = (over: Record<string, unknown> = {}) => ({
  intent: true, payer: PAYER,
  serviceID: 'mtn-data', serviceCategory: 'INTERNET', network: 'MTN', billersCode: '08012345678', phone: '08012345678',
  variation_code: 'mtn-10mb-100', nairaAmount: 100, ...over,
});
const post = async (body: object) => {
  const res = await POST(new Request('http://localhost/api/pay/nim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  db = createFakeDb();
  db.tables.platform_settings = [{ id: 1, exchange_rate: '1500' }];
  alerts.length = 0;
  gateCalls.length = 0;
  offCategories = [];
  balanceLuna = null;
  nimDiscount = { enabled: false, percent: 0 };
});

describe('/api/pay/nim — creating an order', () => {
  it('records a whole order as before', async () => {
    const r = await post(order());
    expect(r.status).toBe(200);
    expect(db.tables.transactions[0]).toMatchObject({ service_category: 'INTERNET', network: 'MTN', status: 'PENDING', blockchain: 'NIMIQ' });
  });

  it('normalises a lower-case category and fills a missing network from the service id', async () => {
    const r = await post(order({ serviceCategory: 'data', network: undefined }));
    expect(r.status).toBe(200);
    expect(db.tables.transactions[0]).toMatchObject({ service_category: 'DATA', network: 'MTN', service_id: 'mtn-data' });
    expect(gateCalls[0]).toMatchObject({ serviceCategory: 'DATA' }); // kill switches see the real category
    expect(alerts).toEqual([]);
  });

  it.each([
    ['no service id', { serviceID: undefined }],
    ['no category', { serviceCategory: '' }],
    ['no account or phone', { billersCode: undefined, phone: undefined }],
  ])('refuses an order with %s before writing anything — 400, no alarm, nothing charged', async (_label, over) => {
    const r = await post(order(over));
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ success: false, code: 'MISSING_BILL_DETAILS' });
    expect(String(r.json.message)).toMatch(/Nothing was charged/);
    expect(db.tables.transactions ?? []).toHaveLength(0);
    expect(alerts).toEqual([]);
  });
});

describe('/api/pay/nim — the same admin settings as abapays.com', () => {
  it('prices with the naira rate set in the admin (platform_settings.exchange_rate)', async () => {
    db.tables.platform_settings = [{ id: 1, exchange_rate: '1000' }];
    const r = await post(order({ nairaAmount: 1000 })); // $1 at 1000/$, NIM at $0.001, +buffer
    expect(r.status).toBe(200);
    expect(r.json.nim).toBe(Math.ceil(1000 * 1.02));
  });

  it('reports a service switched off in the admin as unavailable, through the same gate', async () => {
    offCategories = ['ELECTRICITY'];
    const q = await (await GET()).json();
    expect(q.services.ELECTRICITY).toMatchObject({ available: false, reason: expect.stringMatching(/Switched off/) });
    expect(q.services.AIRTIME).toEqual({ available: true });
    expect(gateCalls.map((g) => g.serviceCategory)).toEqual(expect.arrayContaining(['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'BANK', 'INTERNATIONAL']));
  });

  it('checks one provider and amount without writing anything', async () => {
    offCategories = ['AIRTIME'];
    const r = await post({ check: true, serviceID: 'mtn', serviceCategory: 'airtime', nairaAmount: 200 });
    expect(r.json).toMatchObject({ allowed: false, code: 'SERVICE_UNAVAILABLE' });
    expect(gateCalls[0]).toMatchObject({ serviceCategory: 'AIRTIME', serviceID: 'mtn', amountNgn: 200 });
    expect(db.tables.transactions ?? []).toHaveLength(0);
  });
});

// The NIM discount: one switch and one percentage in the admin (migration 045), separate from
// abapays.com's campaigns. Off → priced exactly as before; on → the percentage off the bill.
describe('/api/pay/nim — the NIM discount', () => {
  it('off: no discount, priced as before, nothing recorded', async () => {
    db.tables.platform_settings = [{ id: 1, exchange_rate: '1000' }];
    const r = await post(order({ nairaAmount: 1000 }));
    expect(r.json.nim).toBe(Math.ceil(1000 * 1.02));
    expect(r.json.charges).toMatchObject({ discountNgn: 0, discountPercent: null });
    expect(db.tables.transactions[0]).toMatchObject({ discount_ngn: 0, discount_percent: null });
  });

  it('on at 10%: takes 10% off the bill, records the naira and the percentage', async () => {
    nimDiscount = { enabled: true, percent: 10 };
    db.tables.platform_settings = [{ id: 1, exchange_rate: '1000' }];
    const r = await post(order({ nairaAmount: 1000 })); // ₦900 = $0.90 at 1000/$, NIM at $0.001, +buffer
    expect(r.status).toBe(200);
    expect(r.json.nim).toBe(Math.ceil(900 * 1.02));
    expect(r.json.charges).toMatchObject({ discountNgn: 100, discountPercent: 10 });
    expect(db.tables.transactions[0]).toMatchObject({ amount_naira: 1000, discount_ngn: 100, discount_percent: 10 });
    expect(db.tables.transactions[0].discount_campaign_id ?? null).toBeNull(); // not a campaign discount
  });

  it('the quote tells the mini app the discount, so its estimate matches', async () => {
    nimDiscount = { enabled: true, percent: 12.5 };
    const q = await (await GET()).json();
    expect(q.discount).toEqual({ enabled: true, percent: 12.5 });
  });
});

// A computed balance can miss a Nimiq Pay HTLC and read short (even 0) for a funded wallet, so it
// never refuses an order: Nimiq Pay refuses an unaffordable send itself, with its exact balance.
describe('/api/pay/nim — a computed balance never refuses an order', () => {
  it.each([
    ['reads 0 (an HTLC we could not see)', 0],
    ['reads short', 50 * 100_000],
    ['is unreadable', null],
  ])('goes ahead when the balance %s', async (_label, value) => {
    balanceLuna = value;
    const r = await post(order());
    expect(r.status).toBe(200);
    expect(r.json.code).not.toBe('INSUFFICIENT_NIM');
    expect(db.tables.transactions).toHaveLength(1);
  });
});
