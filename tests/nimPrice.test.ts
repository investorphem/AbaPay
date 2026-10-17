import { describe, it, expect, vi, beforeEach } from 'vitest';

// NIM is quoted at what it SELLS for on the exchanges (src/lib/nimiq.ts nimUsdPrice): the lowest
// best-bid across qualifying CoinGecko exchange markets, never above the blended price, with the
// blended price alone as the fallback — and the on-chain balance read used at Pay.

vi.mock('server-only', () => ({}));

let simple: unknown;
let tickers: unknown;
let account: unknown;
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('/simple/price')) { if (simple instanceof Error) throw simple; return new Response(JSON.stringify(simple)); }
  if (u.includes('/tickers')) { if (tickers instanceof Error) throw tickers; return new Response(JSON.stringify(tickers)); }
  const body = JSON.parse(String(init?.body || '{}'));
  if (body.method === 'getAccountByAddress') {
    if (account instanceof Error) throw account;
    return new Response(JSON.stringify(account));
  }
  throw new Error(`unexpected fetch ${u}`);
});

const market = (over: Record<string, unknown> = {}) => ({
  target: 'USDT', is_stale: false, is_anomaly: false, trust_score: 'green',
  bid_ask_spread_percentage: 0.2, converted_last: { usd: 0.000284 }, converted_volume: { usd: 20_000 }, ...over,
});

// A fresh module per test: the price is cached for a minute.
const load = async () => { vi.resetModules(); return import('@/lib/nimiq'); };

beforeEach(() => {
  simple = { 'nimiq-2': { usd: 0.000290 } };
  tickers = { tickers: [market({ converted_last: { usd: 0.000284 } }), market({ converted_last: { usd: 0.000280 }, bid_ask_spread_percentage: 1 })] };
  account = { result: { data: { address: 'x', balance: 123_456_789, type: 'basic' } } };
});

describe('nimUsdPrice — priced at what NIM sells for', () => {
  it('uses the lowest best bid across exchange markets, below the blended price', async () => {
    const nim = await load();
    // 0.000280 less half of a 1% spread = 0.0002786; the other market bids ~0.0002837.
    expect(await nim.nimUsdPrice()).toBeCloseTo(0.000280 * (1 - 0.005), 10);
  });

  it('never quotes above the blended price', async () => {
    simple = { 'nimiq-2': { usd: 0.000200 } };
    const nim = await load();
    expect(await nim.nimUsdPrice()).toBe(0.000200);
  });

  it('ignores stale, anomalous, red-trust, thin and non-dollar markets', async () => {
    tickers = { tickers: [
      market({ converted_last: { usd: 0.000284 } }),
      market({ converted_last: { usd: 0.000100 }, is_stale: true }),
      market({ converted_last: { usd: 0.000100 }, is_anomaly: true }),
      market({ converted_last: { usd: 0.000100 }, trust_score: 'red' }),
      market({ converted_last: { usd: 0.000100 }, converted_volume: { usd: 50 } }),
      market({ converted_last: { usd: 0.000100 }, target: 'BTC' }),
    ] };
    const nim = await load();
    expect(await nim.nimUsdPrice()).toBeCloseTo(0.000284 * (1 - 0.001), 10);
  });

  it('falls back to the blended price when no exchange market qualifies, and to nothing at all', async () => {
    tickers = new Error('rate limited');
    let nim = await load();
    expect(await nim.nimUsdPrice()).toBe(0.000290);
    simple = new Error('down');
    nim = await load();
    expect(await nim.nimUsdPrice()).toBeNull(); // the route then refuses to price, never guesses
  });
});

describe('nimBalanceLuna — the wallet balance from the Nimiq chain', () => {
  const ADDR = 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG';

  it('reads the balance in luna', async () => {
    const nim = await load();
    expect(await nim.nimBalanceLuna(ADDR)).toBe(123_456_789);
  });

  it('is null (never 0) when the chain cannot be read, or for a bad address', async () => {
    account = new Error('ECONNREFUSED');
    const nim = await load();
    expect(await nim.nimBalanceLuna(ADDR)).toBeNull();
    expect(await nim.nimBalanceLuna('not-an-address')).toBeNull();
  });
});
