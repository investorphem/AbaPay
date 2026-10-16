import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ THE WHATSAPP CHECKOUT FORM (src/lib/whatsappCheckout.ts). Screens walk SERVICE → PROVIDER →
// DETAILS → CONFIRM with live data; the verified order is stored server-side against the
// token's chat and claimed exactly once; bad input stays on DETAILS with the reason.

let db: FakeDb;
const verify = vi.fn(async (): Promise<Record<string, unknown>> => ({ success: true, customer_name: 'ADA OBI', customer_address: '1 Main St', min_amount: 1000 }));
vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/vtpassCatalog', () => ({
  getCatalog: async (cat: string) => ({
    providers: cat === 'data'
      ? [{ serviceID: 'mtn-data', displayName: 'MTN Data', logo: '', minAmount: null, maxAmount: null }, { serviceID: 'smile-direct', displayName: 'Smile', logo: '', minAmount: null, maxAmount: null }]
      : [{ serviceID: 'ikeja-electric', displayName: 'Ikeja Electric', logo: '', minAmount: 500, maxAmount: 100000 }],
  }),
  limitsFor: async () => ({ min: 500, max: 100000 }),
}));
vi.mock('@/lib/deai/services', () => ({
  fetchDataVariations: async () => [{ code: 'mtn-1gb', name: '1GB Weekly Plan - N1,000', price: 1000 }],
  verifyAccount: (...a: unknown[]) => verify(...(a as [])),
}));

const ck = await import('@/lib/whatsappCheckout');
const CHAT = '2348012345678';
const TOKEN = `abapay-checkout:${CHAT}:n1`;

beforeEach(() => {
  db = createFakeDb({ whatsapp_flow_orders: [], agent_links: [{ channel: 'WHATSAPP', channel_user_id: CHAT, is_active: true, link_verified: true, approved_chain: 'celo', approved_token: 'USD₮' }] });
  db.unique.whatsapp_flow_orders = ['flow_token'];
  verify.mockClear();
});

const ask = (screen: string, data: Record<string, unknown>, flow_token = TOKEN) => ck.handleCheckoutRequest({ action: 'data_exchange', screen, data, flow_token });

describe('screens', () => {
  it('answers ping, INIT and error notifications', async () => {
    expect(await ck.handleCheckoutRequest({ action: 'ping' })).toEqual({ data: { status: 'active' } });
    expect((await ck.handleCheckoutRequest({ action: 'INIT', flow_token: TOKEN })).screen).toBe('SERVICE');
    expect(await ck.handleCheckoutRequest({ action: 'data_exchange', data: { error: 'x' }, flow_token: TOKEN })).toEqual({ data: { acknowledged: true } });
  });

  it('SERVICE → providers, leaving out ones the form can’t complete', async () => {
    const r = await ask('SERVICE', { service: 'DATA' });
    expect(r).toMatchObject({ screen: 'PROVIDER', data: { service: 'DATA', providers: [{ id: 'mtn-data', title: 'MTN Data' }] } });
  });

  it('PROVIDER → details with the live plans for that provider', async () => {
    const r = await ask('PROVIDER', { service: 'DATA', provider: 'mtn-data' });
    expect(r.screen).toBe('DETAILS');
    expect(r.data).toMatchObject({ show_plan: true, show_amount: false, plans: [{ id: 'mtn-1gb', title: '₦1,000 · 1GB Weekly Plan' }] });
  });

  it('a token for no chat (or a forged one) never reaches the order screens', async () => {
    expect((await ask('SERVICE', { service: 'DATA' }, 'nonsense')).screen).toBe('SERVICE');
  });
});

describe('DETAILS → CONFIRM: the order', () => {
  it('builds the engine’s order server-side, with the approved chain/token, and stores it against the chat', async () => {
    const r = await ask('DETAILS', { service: 'DATA', provider: 'mtn-data', number: '+234 801 234 5678', plan: 'mtn-1gb' });
    expect(r.screen).toBe('CONFIRM');
    expect(String(r.data.summary)).toMatch(/1GB Weekly Plan/);
    expect(db.tables.whatsapp_flow_orders[0]).toMatchObject({
      chat_id: CHAT, flow_token: TOKEN,
      intent_data: { intent: 'VEND_DATA', provider: 'mtn-data', destination_account: '08012345678', variation_code: 'mtn-1gb', amount_ngn: 1000, chain: 'CELO', selected_token: 'USD₮', email_choice_made: true },
    });
  });

  it('verifies a meter with VTpass and carries the verified name into the order', async () => {
    const r = await ask('DETAILS', { service: 'ELECTRICITY', provider: 'ikeja-electric', number: '45012345678', meter_type: 'prepaid', amount: '2000', phone: '08012345678' });
    expect(r.screen).toBe('CONFIRM');
    expect(verify).toHaveBeenCalledWith('ikeja-electric', '45012345678', 'prepaid');
    expect(db.tables.whatsapp_flow_orders[0].intent_data).toMatchObject({ intent: 'ELECTRICITY', verified_name: 'ADA OBI', meter_type: 'prepaid', amount_ngn: 2000, phone: '08012345678' });
  });

  it('stays on DETAILS with the reason when something is wrong', async () => {
    expect((await ask('DETAILS', { service: 'DATA', provider: 'mtn-data', number: '0801', plan: 'mtn-1gb' })).screen).toBe('DETAILS');
    expect((await ask('DETAILS', { service: 'DATA', provider: 'mtn-data', number: '08012345678', plan: 'nope' })).data).toMatchObject({ has_error: true, error_message: 'Choose a plan.' });
    expect((await ask('DETAILS', { service: 'ELECTRICITY', provider: 'ikeja-electric', number: '45012345678', amount: '100', phone: '08012345678' })).data).toMatchObject({ has_error: true });
    verify.mockResolvedValueOnce({ success: false, message: 'Invalid meter' });
    expect((await ask('DETAILS', { service: 'ELECTRICITY', provider: 'ikeja-electric', number: '45012345678', amount: '2000', phone: '08012345678' })).data).toMatchObject({ error_message: 'Invalid meter' });
    expect(db.tables.whatsapp_flow_orders).toHaveLength(0);
  });
});

describe('claimFlowOrder / checkoutCompletion', () => {
  it('claims the stored order once', async () => {
    await ask('DETAILS', { service: 'DATA', provider: 'mtn-data', number: '08012345678', plan: 'mtn-1gb' });
    expect(await ck.claimFlowOrder(CHAT)).toMatchObject({ intent: 'VEND_DATA' });
    expect(await ck.claimFlowOrder(CHAT)).toBeNull();
  });

  it('ignores an expired order', async () => {
    await ask('DETAILS', { service: 'DATA', provider: 'mtn-data', number: '08012345678', plan: 'mtn-1gb' });
    db.tables.whatsapp_flow_orders[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await ck.claimFlowOrder(CHAT)).toBeNull();
  });

  it('accepts a submitted form only from the chat its token was issued to', () => {
    const msg = (token: string) => ({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ flow_token: token, confirmed: 'yes' }) } } });
    expect(ck.checkoutCompletion(msg(TOKEN), CHAT)).toBe(CHAT);
    expect(ck.checkoutCompletion(msg(TOKEN), '2348099999999')).toBeNull();
    expect(ck.checkoutCompletion(msg('abapay-pin:x'), CHAT)).toBeNull();
  });

  it('the trigger words open the form; ordinary sentences don’t', () => {
    for (const t of ['menu', 'Hi', 'hello!', ' buy ']) expect(ck.CHECKOUT_TRIGGER_RE.test(t)).toBe(true);
    for (const t of ['buy 500 mtn airtime', 'hi there can you help', '1234']) expect(ck.CHECKOUT_TRIGGER_RE.test(t)).toBe(false);
  });
});
