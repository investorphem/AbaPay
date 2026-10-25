import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Prezenti milestone 1 (src/lib/grantReport.ts): only successful Celo payments from EXTERNAL
// agents count — x402 agents and MCP/A2A agents through the relayer — never AbaPay's web app,
// its own chat agent, refunds/failures or excluded wallets.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/paymentProof', () => ({ vaultAddressFor: () => '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c' }));

const { buildGrantReport, grantReportCsv, externalRail } = await import('@/lib/grantReport');

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const OURS = '0x9999999999999999999999999999999999999999';
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;
const tx = (over: Record<string, unknown>) => ({
  id: `t${++n}`, created_at: '2026-11-10T12:00:00Z', status: 'SUCCESS', blockchain: 'CELO', tx_hash: hash(), request_id: `r${n}`,
  wallet_address: W1, token_used: 'USDC', amount_usdt: 1, payment_method: 'X402', source_channel: 'AGENT', service_category: 'AIRTIME', network: 'MTN', ...over,
});

beforeEach(() => {
  process.env.GRANT_EXCLUDED_WALLETS = OURS;
  db = createFakeDb({ transactions: [], payment_client_info: [], payer_identities: [] });
});

describe('externalRail', () => {
  it.each([
    [{ payment_method: 'X402', source_channel: 'AGENT' }, 'x402'],
    [{ payment_method: 'X402', source_channel: 'WEB' }, null],
    [{ payment_method: 'AGENT_RELAY', source_channel: 'MCP' }, 'MCP'],
    [{ payment_method: 'AGENT_RELAY', source_channel: 'TELEGRAM' }, null],
    [{ payment_method: 'AGENT_RELAY', source_channel: 'SCHEDULE' }, null],
    [{ payment_method: 'CONTRACT', source_channel: 'WEB' }, null],
  ])('%o → %s', (t, rail) => expect(externalRail(t)).toBe(rail));
  it('reads A2A from the recorded protocol', () => expect(externalRail({ payment_method: 'AGENT_RELAY', source_channel: 'MCP' }, { protocol: 'A2A' })).toBe('A2A'));
});

describe('buildGrantReport', () => {
  it('counts only external-agent payments in the window, and attributes them to agents', async () => {
    const earmark = tx({ wallet_address: W1, amount_usdt: 2 });
    const mcp = tx({ payment_method: 'AGENT_RELAY', source_channel: 'MCP', wallet_address: W2, amount_usdt: 3, token_used: 'USD₮' });
    db.tables.transactions = [
      earmark, mcp,
      tx({ source_channel: 'WEB' }), // AbaPay's own web app
      tx({ payment_method: 'AGENT_RELAY', source_channel: 'TELEGRAM' }), // AbaPay's own chat agent
      tx({ status: 'REFUNDED' }), tx({ status: 'FAILED_VENDING' }),
      tx({ wallet_address: OURS }), // excluded wallet
      tx({ blockchain: 'BASE' }),
      tx({ created_at: '2026-12-25T00:00:00Z' }), // outside the window
      tx({ tx_hash: 'preflight_x402_abc' }), // not on chain
    ];
    db.tables.payer_identities = [{ wallet: W1, erc8004_agents: [{ id: '9806', relation: 'owner', name: 'Earmark' }], self_verified: false }];
    db.tables.payment_client_info = [{ transaction_id: mcp.id, declared_agent: null, client_diag: { protocol: 'MCP', auth: 'oauth', oauth_client_name: 'Claude', self_agent: { status: 'verified', agent_id: '42' } } }];

    const r = await buildGrantReport('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(r.totals).toEqual({ payments: 2, wallets: 2, volume_usd: 5, agents: 2 });
    expect(r.agents.map((a) => a.agent).sort()).toEqual(['Claude (OAuth client)', 'Earmark (ERC-8004 #9806)']);
    expect(r.agents.find((a) => a.agent.startsWith('Claude'))).toMatchObject({ integrations: ['MCP'], self_agent: 'verified #42' });
    expect(r.payments.every((p) => p.recipient === '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c')).toBe(true);
    expect(r.met).toEqual({ payments: false, wallets: false, volume: false, agents: false });
  });

  it('marks the targets met', async () => {
    db.tables.transactions = Array.from({ length: 1000 }, (_, i) => tx({ wallet_address: `0x${(i % 30 + 1).toString(16).padStart(40, '0')}`, amount_usdt: 1.5 }));
    const r = await buildGrantReport('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(r.totals.payments).toBe(1000);
    expect(r.totals.wallets).toBe(30);
    expect(r.met).toMatchObject({ payments: true, wallets: true, volume: true });
  });

  it('writes the CSV the final report attaches', async () => {
    db.tables.transactions = [tx({ wallet_address: W1, amount_usdt: 2 })];
    const csv = grantReportCsv(await buildGrantReport('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'));
    const [head, row] = csv.trim().split('\n');
    expect(head).toBe('tx_hash,date,token,amount,sender,recipient,agent,integration,erc8004_id,self_agent,service,celoscan');
    expect(row).toContain(W1);
    expect(row).toContain('https://celoscan.io/tx/0x');
  });
});
