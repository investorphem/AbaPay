import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// GET /api/agent/payout: a verified agent reads the bank transfer it paid for. It is the payee's
// bank account, so only the agent key the payment was made under gets an answer.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
let self: Record<string, unknown> = { present: false };
vi.mock('@/lib/selfAgent', () => ({ verifySelfAgentRequest: async () => self }));

const { GET } = await import('@/app/api/agent/payout/route');
const { toBytea } = await import('@/lib/bankPayouts');

const TX = `0x${'cd'.repeat(32)}`;
const AGENT = '0xAbC0000000000000000000000000000000000001';
const get = async (q: string) => { const res = await GET(new Request(`https://agents.abapays.com/api/agent/payout?${q}`)); return { status: res.status, res }; };
const payout = (over: Record<string, unknown> = {}) => ({
  id: 'p1', transaction_id: 't1', tx_hash: TX, wallet: '0x1', self_agent_id: '205', self_agent_address: AGENT.toLowerCase(),
  bank_code: '044', bank_name: 'Access Bank', account_number: '0123456789', account_name: 'ADA OBI', amount_ngn: 250000,
  status: 'PAID', payout_reference: 'NIP-0001', proof_mime: 'image/png', proof_image: toBytea(Buffer.from('png!')),
  operator_note: null, paid_at: '2026-11-21T10:00:00Z', paid_by: '0xadmin', created_at: '2026-11-21T09:00:00Z', ...over,
});

beforeEach(() => { db = createFakeDb({ bank_payouts: [payout()] }); self = { present: false }; });

describe('GET /api/agent/payout', () => {
  it('asks for a Self signature', async () => {
    expect((await get(`tx=${TX}`)).status).toBe(401);
  });

  it('answers the agent that paid with the reference and a link to the receipt', async () => {
    self = { present: true, status: 'verified', agentAddress: AGENT, agentId: '205' };
    const { status, res } = await get(`tx=${TX}`);
    expect(status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'PAID', reference: 'NIP-0001', account_name: 'ADA OBI', proof_url: `https://agents.abapays.com/api/agent/payout?tx=${TX}&proof=1` });
  });

  it('serves the receipt itself, still to the same key after its proof expired', async () => {
    self = { present: true, status: 'expired', agentAddress: AGENT, agentId: '205', detail: 'expired' };
    const { status, res } = await get(`tx=${TX}&proof=1`);
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png!');
  });

  it('tells any other agent key nothing', async () => {
    self = { present: true, status: 'verified', agentAddress: '0x9999999999999999999999999999999999999999', agentId: '7' };
    expect((await get(`tx=${TX}`)).status).toBe(404);
    expect((await get(`tx=${TX}&proof=1`)).status).toBe(404);
  });

  it('refuses a signature that does not check out', async () => {
    self = { present: true, status: 'invalid', detail: 'bad signature' };
    expect((await get(`tx=${TX}`)).status).toBe(401);
  });

  it('shows a queued transfer without a reference', async () => {
    db.tables.bank_payouts = [payout({ status: 'AWAITING', payout_reference: null, proof_mime: null, proof_image: null, paid_at: null })];
    self = { present: true, status: 'verified', agentAddress: AGENT, agentId: '205' };
    const body = await (await get(`tx=${TX}`)).res.json();
    expect(body).toMatchObject({ status: 'AWAITING_PAYOUT' });
    expect(body.reference).toBeUndefined();
  });
});
