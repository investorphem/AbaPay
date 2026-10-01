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
vi.mock('@/lib/messaging', () => ({ sendAbaPaySms: async () => {} }));
vi.mock('@/lib/vtpass', () => ({ getHeaders: () => ({}) }));
vi.mock('@/lib/refunds', () => ({ enqueueRefund: () => enqueueRefund() }));
vi.mock('@/lib/monnifyVend', () => ({ initiateMonnifyBankTransfer: async () => ({ success: true, status: 'TIMEOUT' }) }));
vi.mock('@/lib/balanceAlerts', () => ({ checkProviderBalances: async () => ({ ok: true }) }));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));
const tripCircuit = vi.fn(async (_p: string, _r: string) => {});
vi.mock('@/lib/circuitBreaker', () => ({ tripCircuit: (p: string, r: string) => tripCircuit(p, r) }));

vi.stubGlobal('fetch', async (url: string) => {
  if (!String(url).endsWith('/pay')) throw new Error(`unexpected fetch ${url}`);
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
