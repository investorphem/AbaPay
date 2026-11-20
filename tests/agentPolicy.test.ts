import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Outside-agent terms (src/lib/agentPolicy.ts): a verified Self Agent ID earns the perks the
// operator switched on; anything else — no headers, an expired proof, a revoked key — earns none.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));

const { agentTerms, checkAgentCaps, policyFromRow, POLICY_OFF, getAgentPolicy, clearAgentPolicyCache } = await import('@/lib/agentPolicy');

const VERIFIED = { present: true, status: 'verified', agentAddress: '0xAbC0000000000000000000000000000000000001', agentId: '205' } as const;
const WALLET = '0x1111111111111111111111111111111111111111';
const ALL_ON = policyFromRow({
  agent_ext_max_ngn_per_tx: 20000, agent_ext_daily_cap_ngn: 50000,
  verified_agent_discounts_enabled: true, verified_agent_fee_waiver_enabled: true,
  verified_agent_higher_limits_enabled: true, verified_agent_max_ngn_per_tx: 500000, verified_agent_daily_cap_ngn: null,
  verified_agent_bank_enabled: true,
});

beforeEach(() => { db = createFakeDb({ transactions: [] }); clearAgentPolicyCache(); });

describe('agentTerms', () => {
  it('gives a verified agent the perks that are switched on, and its own caps', () => {
    expect(agentTerms(VERIFIED, ALL_ON)).toEqual({
      verified: true, selfAgentId: '205', selfAgentAddress: VERIFIED.agentAddress,
      discounts: true, feeWaived: true, maxNgnPerTx: 500000, dailyCapNgn: null, bankAllowed: true,
    });
  });

  it.each([
    ['no Self headers', { present: false }],
    ['an expired proof', { present: true, status: 'expired', agentAddress: VERIFIED.agentAddress, agentId: '205', detail: 'x' }],
    ['a revoked key', { present: true, status: 'not_registered', agentAddress: VERIFIED.agentAddress, detail: 'x' }],
    ['a registry outage', { present: true, status: 'unavailable', agentAddress: VERIFIED.agentAddress, detail: 'x' }],
  ] as const)('gives %s no perks and the outside-agent caps', (_label, self) => {
    expect(agentTerms(self, ALL_ON)).toEqual({
      verified: false, selfAgentId: null, selfAgentAddress: null,
      discounts: false, feeWaived: false, maxNgnPerTx: 20000, dailyCapNgn: 50000, bankAllowed: false,
    });
  });

  it('keeps the outside-agent caps for a verified agent when higher limits are off', () => {
    const t = agentTerms(VERIFIED, { ...ALL_ON, verifiedHigherLimits: false });
    expect(t).toMatchObject({ verified: true, maxNgnPerTx: 20000, dailyCapNgn: 50000 });
  });

  it('starts with everything off and no caps', () => {
    expect(policyFromRow(null)).toEqual(POLICY_OFF);
    expect(agentTerms(VERIFIED, POLICY_OFF)).toMatchObject({ discounts: false, feeWaived: false, bankAllowed: false, maxNgnPerTx: null, dailyCapNgn: null });
  });

  it('applies nothing when the settings cannot be read', async () => {
    db.tables.platform_settings = []; // .single() finds no row
    expect(await getAgentPolicy()).toEqual(POLICY_OFF);
  });
});

describe('checkAgentCaps', () => {
  const unverified = agentTerms({ present: false }, ALL_ON);
  const order = (amount: number, over: Record<string, unknown> = {}) => ({
    wallet_address: WALLET, source_channel: 'AGENT', status: 'SUCCESS', amount_naira: amount,
    service_category: 'AIRTIME', self_agent_id: null, created_at: new Date().toISOString(), ...over,
  });

  it('refuses an order above the per-order cap, and says a Self Agent ID can raise it', async () => {
    const r = await checkAgentCaps({ terms: unverified, wallet: WALLET, amountNgn: 20001, isBank: false });
    expect(r).toMatchObject({ allowed: false, code: 'AGENT_LIMIT' });
    expect(!r.allowed && r.reason).toMatch(/₦20,000.*Self Agent ID/);
  });

  it('counts the last 24 hours of the wallet\'s paid agent orders against the daily cap', async () => {
    db.tables.transactions = [
      order(30000), order(15000),
      order(9000, { status: 'REFUNDED' }), // refunded: doesn't count
      order(9000, { source_channel: 'WEB' }), // a web-app order: doesn't count
      order(9000, { created_at: new Date(Date.now() - 25 * 3600_000).toISOString() }), // older than 24h
    ];
    expect(await checkAgentCaps({ terms: unverified, wallet: WALLET, amountNgn: 5000, isBank: false })).toEqual({ allowed: true });
    const over = await checkAgentCaps({ terms: unverified, wallet: WALLET, amountNgn: 5001, isBank: false });
    expect(!over.allowed && over.reason).toMatch(/₦5,000 left/);
  });

  it('never caps a verified agent\'s bank transfer, nor counts it toward its other orders', async () => {
    const verified = agentTerms(VERIFIED, { ...ALL_ON, verifiedHigherLimits: false });
    expect(await checkAgentCaps({ terms: verified, wallet: WALLET, amountNgn: 5_000_000, isBank: true })).toEqual({ allowed: true });
    db.tables.transactions = [order(49000, { service_category: 'BANK', self_agent_id: '205', status: 'AWAITING_PAYOUT' }), order(40000)];
    expect(await checkAgentCaps({ terms: verified, wallet: WALLET, amountNgn: 10000, isBank: false })).toEqual({ allowed: true });
  });

  it('lets a verified agent with higher limits pay past the outside-agent caps', async () => {
    const verified = agentTerms(VERIFIED, ALL_ON);
    expect(await checkAgentCaps({ terms: verified, wallet: WALLET, amountNgn: 400000, isBank: false })).toEqual({ allowed: true });
  });
});
