import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// /api/deai/chat: anything that reads or changes a wallet's data needs a VERIFIED wallet
// session. A bare x-wallet-address header (public data) is never enough.

let db: FakeDb;
let nextIntent: Record<string, unknown> = { intent: 'HELP' };
// The signature a "real" signer would produce; anything else fails verification.
const GOOD_SIG = '0xgood';

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/rateLimit', () => ({ enforceRateLimit: async () => null, enforceRateLimitByKey: async () => null }));
vi.mock('@/lib/deai/intentEngine', () => ({ parseIntent: async () => nextIntent }));
vi.mock('@/lib/deai/humanize', () => ({ humanizeReply: async (t: string) => t }));
vi.mock('@/lib/serviceRules', () => ({ getServiceRules: async () => ({ aiChatEnabled: true, exchangeRate: 1340 }) }));
vi.mock('@/lib/deai/capabilities', () => ({
  describeCapabilities: async () => 'MENU',
  assessFeasibility: async () => ({ possible: true, missing: [], suggestions: [] }),
  capabilityForIntent: () => null,
  getCapability: () => null,
}));
vi.mock('@/lib/deai/services', () => ({ resolveServiceId: () => 'mtn', fetchCryptoBalances: async () => ({}) }));
vi.mock('@/lib/deai/relayer', () => ({ getRemainingAllowance: async () => 0 }));
vi.mock('@/lib/deai/batch', () => ({
  checkAutonomousCapacity: async () => ({ ok: true, neededCrypto: 1, allowanceRemaining: 10, balance: 10 }),
  groupByChainToken: (items: unknown[]) => new Map([['CELO|USD₮', items]]),
}));
vi.mock('@/utils/walletAuth', () => ({
  verifyWalletSession: async (req: Request) => {
    const address = req.headers.get('x-wallet-address') || '';
    return req.headers.get('x-wallet-signature') === GOOD_SIG
      ? { ok: true, address }
      : { ok: false, message: 'Invalid signature' };
  },
}));

import { POST } from '@/app/api/deai/chat/route';

const VICTIM = '0xabc0000000000000000000000000000000000001';
const ATTACKER = '0xdef0000000000000000000000000000000000002';

beforeEach(() => {
  db = createFakeDb({
    scheduled_bills: [
      { id: 's1', wallet_address: VICTIM, provider: 'MTN', service_category: 'AIRTIME', amount_ngn: 500, frequency: 'daily', is_active: true },
      { id: 's2', wallet_address: ATTACKER, provider: 'GLO', service_category: 'DATA', amount_ngn: 1000, frequency: 'daily', is_active: true },
    ],
  });
});

function chat(message: string, headers: Record<string, string> = {}) {
  return POST(new Request('https://abapays.com/api/deai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message }),
  }));
}

describe('/api/deai/chat wallet scoping', () => {
  it('refuses to list schedules for a spoofed address with no signature', async () => {
    nextIntent = { intent: 'LIST_SCHEDULES' };
    const res = await chat('show my automations', { 'x-wallet-address': VICTIM });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.needsWalletSession).toBe(true);
    expect(body.reply).not.toContain('MTN');
  });

  it('refuses a forged signature', async () => {
    nextIntent = { intent: 'LIST_SCHEDULES' };
    const res = await chat('show my automations', { 'x-wallet-address': VICTIM, 'x-wallet-signature': '0xforged', 'x-wallet-timestamp': String(Date.now()) });
    expect(res.status).toBe(401);
  });

  it('with a verified session, lists only the signer\'s own schedules', async () => {
    nextIntent = { intent: 'LIST_SCHEDULES' };
    const res = await chat('show my automations', { 'x-wallet-address': VICTIM, 'x-wallet-signature': GOOD_SIG, 'x-wallet-timestamp': String(Date.now()) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.reply).toContain('MTN');
    expect(body.reply).not.toContain('GLO');
  });

  it('cancel never changes anything server-side; it proposes a signed cancel instead', async () => {
    nextIntent = { intent: 'CANCEL_SCHEDULE', provider: 'MTN' };
    const res = await chat('cancel my mtn automation', { 'x-wallet-address': VICTIM, 'x-wallet-signature': GOOD_SIG, 'x-wallet-timestamp': String(Date.now()) });
    const body = await res.json();
    expect(body.cancelConfirm).toEqual({ id: 's1', label: 'MTN AIRTIME' });
    expect(db.tables.scheduled_bills.every((s) => s.is_active)).toBe(true);
  });

  it('a spoofed cancel is refused and changes nothing', async () => {
    nextIntent = { intent: 'CANCEL_SCHEDULE', provider: 'MTN' };
    const res = await chat('cancel my mtn automation', { 'x-wallet-address': VICTIM });
    expect(res.status).toBe(401);
    expect(db.tables.scheduled_bills.every((s) => s.is_active)).toBe(true);
  });

  it('a schedule proposal needs a verified session', async () => {
    nextIntent = { intent: 'VEND_AIRTIME', provider: 'MTN', amount_ngn: 500, destination_account: '08012345678', is_recurring: true, frequency: 'daily' };
    expect((await chat('every day 500 mtn to 0801', { 'x-wallet-address': VICTIM })).status).toBe(401);
  });

  it('anonymous help still works', async () => {
    nextIntent = { intent: 'HELP' };
    const res = await chat('what can you do?');
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toBe('MENU');
  });
});
