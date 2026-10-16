import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ THE ENGINE'S CHECKOUT-FORM ENTRY (core/route.ts, `flow_order`). A submitted WhatsApp
// checkout form hands the engine "run the stored order for this chat" with EMPTY text. The order
// must: never go through the AI parser, become the chat's in-progress order, and run the normal
// pipeline to the PIN step (here: a linked user with an approved chain and token).

let db: FakeDb;
const parseIntent = vi.fn(async () => ({ intent: 'UNKNOWN' }));
let storedOrder: Record<string, unknown> | null = null;

vi.mock('server-only', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (t: string) => fakeSupabase(db).from(t), rpc: (n: string, a: unknown) => fakeSupabase(db).rpc(n, a as never) }),
}));
vi.mock('@/utils/internalAuth', () => ({ verifyInternalRequest: () => true }));
vi.mock('@/lib/deai/intentEngine', () => ({ parseIntent: () => parseIntent(), classifyPivot: async () => ({ switching: false }) }));
vi.mock('@/lib/deai/humanize', () => ({ humanizeReply: async (t: string) => t }));
vi.mock('@/lib/deai/services', () => ({ verifyAccount: async () => ({ success: true }), fetchCryptoBalances: async () => ({}), resolveServiceId: (_i: string, p: string) => p }));
vi.mock('@/lib/whatsappCheckout', () => ({ claimFlowOrder: async () => { const o = storedOrder; storedOrder = null; return o; } }));
vi.mock('@/lib/deai/deeplink', () => ({ createDeepLink: async () => 'https://example.test/pay' }));
vi.mock('@/lib/deai/relayer', () => ({ relayPayBillFor: async () => ({}), getRemainingAllowance: async () => 1000 }));
vi.mock('@/lib/serviceRules', () => ({
  checkServiceAllowed: async () => ({ allowed: true }), checkAgentSpendAllowed: async () => ({ allowed: true }),
  isChannelEnabled: async () => true, computeServiceFee: () => 0, getServiceRules: async () => ({ exchangeRate: 1340, killSwitches: {} }),
}));
vi.mock('@/lib/deai/capabilities', () => ({
  assessFeasibility: async () => ({ possible: true, missing: [], suggestions: [], reason: '' }),
  describeCapabilities: () => '', getCapability: () => null, capabilityForIntent: () => null,
}));
vi.mock('@/lib/vtpassCatalog', () => ({ limitsForIntent: async () => ({ min: null, max: null }), limitsFor: async () => ({ min: null, max: null }), getCatalog: async () => ({ providers: [] }) }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {} }));
vi.mock('@/lib/deai/pinSecurity', () => ({ checkPinAllowed: async () => ({ allowed: true }), recordPinFailure: async () => {}, clearPinFailures: async () => {}, notifySpendOutOfBand: async () => {} }));
vi.mock('@/lib/vend', () => ({ executeVend: async () => ({ success: true, status: 'SUCCESS' }), getStrictRequestId: () => 'req' }));
vi.mock('@/lib/deai/batch', () => ({ checkAutonomousCapacity: async () => ({}), groupByChainToken: () => [], executeAgentPayment: async () => ({}) }));
vi.mock('@/lib/discounts', () => ({ getActiveDiscountForService: async () => null, computeDiscountNgn: async () => ({ discountNgn: 0, discountPhone: null }) }));

const { POST } = await import('@/app/api/deai/core/route');

const CHAT = '2348012345678';
const order = () => ({
  intent: 'VEND_DATA', provider: 'mtn-data', provider_label: 'MTN Data', destination_account: '08012345678', phone: '08012345678',
  variation_code: 'mtn-1gb', variation_label: '1GB Weekly Plan', amount_ngn: 1000, chain: 'CELO', selected_token: 'USD₮',
  email: null, email_choice_made: true, pin_attempts: 0, source: 'whatsapp_flow',
});
const run = (body: Record<string, unknown>) => POST(new Request('https://www.abapays.com/api/deai/core', { method: 'POST', body: JSON.stringify({ platform: 'WHATSAPP', platform_id: CHAT, ...body }) }));

beforeEach(() => {
  db = createFakeDb({
    deai_sessions: [],
    agent_links: [{ id: 'l1', channel: 'WHATSAPP', channel_user_id: CHAT, link_verified: true, is_active: true, wallet_address: '0xabc', approved_chain: 'CELO', approved_token: 'USD₮', pin_hash: 'x' }],
    platform_settings: [{ id: 1, exchange_rate: 1340 }],
  });
  db.unique.deai_sessions = ['chat_id'];
  parseIntent.mockClear();
  storedOrder = order();
});

describe('flow_order', () => {
  it('runs the stored order to the PIN step without the AI parser', async () => {
    const res = await run({ text: '', flow_order: true });
    const body = await res.json();
    expect(parseIntent).not.toHaveBeenCalled();
    expect(body.action).toBe('REPLY');
    const session = db.tables.deai_sessions.find((s) => s.chat_id === CHAT);
    expect(session).toMatchObject({ status: 'AWAITING_PIN', intent_data: { intent: 'VEND_DATA', variation_code: 'mtn-1gb', destination_account: '08012345678' } });
  });

  it('says the form expired when there is no stored order', async () => {
    storedOrder = null;
    const body = await (await run({ text: '', flow_order: true })).json();
    expect(body.message).toMatch(/expired/);
    expect(db.tables.deai_sessions).toHaveLength(0);
  });

  it('the chat token reply still reaches the PIN step (shared finishCheckout)', async () => {
    const d = order();
    delete (d as Record<string, unknown>).selected_token;
    db.tables.deai_sessions.push({ chat_id: CHAT, platform: 'WHATSAPP', status: 'AWAITING_TOKEN', intent_data: d, expires_at: new Date(Date.now() + 300_000).toISOString() });
    const body = await (await run({ text: '1' })).json();
    expect(body.message).toMatch(/Final Checkout/);
    expect(db.tables.deai_sessions.find((s) => s.chat_id === CHAT)).toMatchObject({ status: 'AWAITING_PIN', intent_data: { selected_token: expect.any(String) } });
  });

  it('a preset token that does not exist on the chain is asked again instead', async () => {
    storedOrder = { ...order(), selected_token: 'NOPE' };
    const body = await (await run({ text: '', flow_order: true })).json();
    expect(body.message).toMatch(/Which token/);
    expect(db.tables.deai_sessions.find((s) => s.chat_id === CHAT)).toMatchObject({ status: 'AWAITING_TOKEN' });
  });

  it('is ignored on other channels', async () => {
    await run({ platform: 'TELEGRAM', text: 'hello', flow_order: true });
    expect(storedOrder).not.toBeNull();
  });
});
