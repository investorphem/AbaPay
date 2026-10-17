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
vi.mock('@/lib/discounts', () => ({ getActiveDiscountForService: async () => null, computeDiscountNgn: async () => ({ discountNgn: 0, discountPhone: null }) }));
vi.mock('@/lib/parity', () => ({ isDuplicateElectricity: async () => false }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/serviceRules', () => ({ checkWebPayment: async (a: Record<string, unknown>) => { gateCalls.push(a); return { allowed: true }; } }));
vi.mock('@/lib/billCharges', () => ({ billCharges: () => ({ serviceFee: 0, stampDutyNgn: 0 }) }));
vi.mock('@/lib/nimSettle', () => ({ NIM_INTENT_PREFIX: 'nim_intent_', settleNimIntent: async () => ({}) }));
vi.mock('@/lib/nimiq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nimiq')>();
  return { ...actual, treasuryAddress: () => 'NQ36 8QDJ 26LU ABEG 3E84 14NT 4HBB 91GC 36P3', nimUsdPrice: async () => 0.001 };
});

const { POST } = await import('@/app/api/pay/nim/route');
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
