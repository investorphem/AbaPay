import { describe, it, expect, vi, beforeEach } from 'vitest';

// GET /api/pay/nim/balance — the balance the mini app shows, read from the Nimiq chain (Nimiq
// Pay's own getBalance answered 0 for funded wallets).

vi.mock('server-only', () => ({}));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null }));
let chain: number | null = null;
const reads: string[] = [];
vi.mock('@/lib/nimiq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nimiq')>();
  return { ...actual, nimBalanceLuna: async (a: string) => { reads.push(a); return chain; } };
});

const { GET } = await import('@/app/api/pay/nim/balance/route');
const ADDR = 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG';
const get = async (address: string) => {
  const res = await GET(new Request(`http://localhost/api/pay/nim/balance?address=${encodeURIComponent(address)}`));
  return { status: res.status, json: await res.json(), cache: res.headers.get('cache-control') };
};

beforeEach(() => { chain = null; reads.length = 0; });

describe('/api/pay/nim/balance', () => {
  it('returns the on-chain balance in luna, uncached', async () => {
    chain = 1_234_500_000; // 12,345 NIM
    const r = await get(ADDR);
    expect(r).toMatchObject({ status: 200, json: { balance_luna: 1_234_500_000 }, cache: 'no-store' });
    expect(reads).toEqual([ADDR]);
  });

  it('is null (the app then falls back to Nimiq Pay) when the chain cannot be read', async () => {
    expect((await get(ADDR)).json).toEqual({ balance_luna: null });
  });

  it('refuses something that is not a Nimiq address without reading the chain', async () => {
    const r = await get('0x1111111111111111111111111111111111111111');
    expect(r.status).toBe(400);
    expect(reads).toEqual([]);
  });
});
