import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// 🤖 MCP/A2A payments record which client paid (src/lib/payerIdentity.ts runWithAgentClient →
// executeAgentPayment). Our own chat agent and the scheduler call the same executeAgentPayment
// outside that context and must record nothing.

vi.mock('server-only', () => ({}));

let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/deai/relayer', () => ({
  getRemainingAllowance: async () => 0,
  // Refused before anything moves: enough to prove the row was written and recorded.
  relayPayBillFor: async () => ({ success: false, message: 'allowance too low' }),
}));
vi.mock('@/lib/deai/services', () => ({ fetchCryptoBalances: async () => ({}) }));
vi.mock('@/lib/vend', () => ({ executeVend: async () => ({}), getStrictRequestId: () => `req_${Math.random().toString(36).slice(2, 10)}` }));
vi.mock('@/lib/discounts', () => ({ getActiveDiscountForService: async () => null, computeDiscountNgn: async () => ({ discountNgn: 0, discountPhone: null }) }));
vi.mock('@/lib/chain', () => ({
  isMainnetEnv: () => true,
  // The on-chain identity lookup that follows is covered by payerIdentity.test.ts; here it fails fast.
  getPublicClient: () => ({ readContract: async () => { throw new Error('offline'); }, getLogs: async () => { throw new Error('offline'); } }),
}));
vi.mock('@/lib/parity', () => ({ isDuplicateElectricity: async () => false }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {} }));
vi.mock('@/lib/serviceRules', () => ({ computeServiceFee: () => 0 }));
vi.mock('@/lib/idempotency', () => ({ markCommitted: () => {} }));
const oauthLookups: string[] = [];
vi.mock('@/lib/deai/mcpOAuth', () => ({
  oauthClientForAccessToken: async (t: string) => { oauthLookups.push(t); return { client_id: 'cl_123', client_name: 'Claude' }; },
}));
vi.stubGlobal('fetch', async () => { throw new Error('offline'); });

const { executeAgentPayment } = await import('@/lib/deai/batch');
const { runWithAgentClient, agentRequestClient } = await import('@/lib/payerIdentity');

const WALLET = '0x1111111111111111111111111111111111111111';
const item = { serviceCategory: 'AIRTIME', serviceID: 'mtn', provider: 'MTN', billersCode: '08012345678', amountNgn: 200, chain: 'CELO', tokenSymbol: 'USDC' };
const pay = () => executeAgentPayment({ userWallet: WALLET, item: item as never, exchangeRate: 1500, sourceChannel: 'MCP' });
const settle = () => new Promise((r) => setTimeout(r, 0));
const req = (headers: Record<string, string>) => new Request('http://localhost/api/mcp', { method: 'POST', headers });

beforeEach(() => {
  db = createFakeDb();
  oauthLookups.length = 0;
});

describe('MCP / A2A payments record which client paid', () => {
  it('an OAuth MCP call records the protocol and the OAuth client it was issued to', async () => {
    await runWithAgentClient(agentRequestClient(req({ authorization: 'Bearer aba_oat_abc', 'user-agent': 'Claude-User/1.0' }), 'MCP'), pay);
    await settle();
    const tx = db.tables.transactions[0];
    expect(db.tables.payment_client_info).toEqual([expect.objectContaining({
      transaction_id: tx.id, wallet: WALLET,
      user_agent: 'Claude-User/1.0', declared_agent: 'Claude',
      client_diag: { protocol: 'MCP', auth: 'oauth', oauth_client_id: 'cl_123', oauth_client_name: 'Claude' },
    })]);
  });

  it("an agent's own X-Agent-Name wins over the OAuth client's registered name", async () => {
    await runWithAgentClient(agentRequestClient(req({ authorization: 'Bearer aba_oat_abc', 'x-agent-name': 'Earmark', 'x-agent-id': '9806' }), 'A2A'), pay);
    await settle();
    expect(db.tables.payment_client_info[0]).toMatchObject({ declared_agent: 'Earmark', declared_agent_id: '9806', client_diag: { protocol: 'A2A', auth: 'oauth' } });
  });

  it('an API key in the header is recorded as such, with no OAuth lookup', async () => {
    await runWithAgentClient(agentRequestClient(req({ authorization: 'Bearer aba_mcp_xyz' }), 'A2A'), pay);
    await settle();
    expect(db.tables.payment_client_info[0]).toMatchObject({ client_diag: { protocol: 'A2A', auth: 'api_key' } });
    expect(oauthLookups).toEqual([]);
  });

  it('an API key passed as a tool argument (no header) is recorded too', async () => {
    await runWithAgentClient(agentRequestClient(req({}), 'MCP'), pay);
    await settle();
    expect(db.tables.payment_client_info[0]).toMatchObject({ client_diag: { protocol: 'MCP', auth: 'api_key_argument' } });
  });

  it('our own chat agent and the scheduler (no context) record nothing', async () => {
    await pay();
    await settle();
    expect(db.tables.transactions).toHaveLength(1);
    expect(db.tables.payment_client_info ?? []).toHaveLength(0);
  });

  it('a call that pays nothing looks nothing up', async () => {
    await runWithAgentClient(agentRequestClient(req({ authorization: 'Bearer aba_oat_abc' }), 'MCP'), async () => 'balance checked');
    await settle();
    expect(oauthLookups).toEqual([]);
    expect(db.tables.payment_client_info ?? []).toHaveLength(0);
  });
});
