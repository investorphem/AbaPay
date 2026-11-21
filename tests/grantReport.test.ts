import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Prezenti milestone 1 (src/lib/grantReport.ts): the chain is the judge. Payments come from the
// on-chain indexer (onchain_payments); AbaPay's own records only name the agent and apply the
// agreement's exclusions — the web app, AbaPay's own chat agent, undelivered orders, excluded
// wallets. An x402 payment with no AbaPay order still counts, flagged.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));

const { buildGrantReport, grantReportCsv, externalRail } = await import('@/lib/grantReport');

const VAULT = '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c';
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const W3 = '0x3333333333333333333333333333333333333333';
const OURS = '0x9999999999999999999999999999999999999999';
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;
const chain = (over: Record<string, unknown>) => ({
  chain: 'CELO', tx_hash: hash(), log_index: 0, block_time: '2026-11-10T12:00:00Z', contract: VAULT,
  payer: W1, token_symbol: 'USDC', amount_usd: 1, rail: 'x402', ...over,
});
const order = (onchain: { tx_hash: string; payer: string }, over: Record<string, unknown>) => ({
  id: `t${++n}`, status: 'SUCCESS', tx_hash: onchain.tx_hash, x402_settle_tx: onchain.tx_hash, request_id: `r${n}`,
  wallet_address: onchain.payer, payment_method: 'X402', source_channel: 'AGENT', service_category: 'AIRTIME', network: 'MTN', ...over,
});
const WINDOW = ['2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'] as const;

beforeEach(() => {
  process.env.GRANT_EXCLUDED_WALLETS = OURS;
  db = createFakeDb({ onchain_payments: [], onchain_cursors: [], transactions: [], payment_client_info: [], payer_identities: [] });
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

  // Before 2026-10-24 an x402 call that didn't name its source was stored as 'WEB' (Earmark's
  // October payments). Our web app is a browser that declares no agent.
  it.each([
    ['a declared agent name', { declared_agent: 'Earmark', declared_agent_id: '9806', user_agent: 'node' }, 'x402'],
    ['a declared agent id only', { declared_agent: null, declared_agent_id: '9806', user_agent: null }, 'x402'],
    ['a non-browser client', { declared_agent: null, declared_agent_id: null, user_agent: 'python-requests/2.34.2' }, 'x402'],
    ['our web app in a browser', { declared_agent: null, declared_agent_id: null, user_agent: 'Mozilla/5.0 (Linux; Android 16)' }, null],
    ['nothing recorded', null, null],
  ])("x402 stored as 'WEB' with %s → %s", (_label, client, rail) =>
    expect(externalRail({ payment_method: 'X402', source_channel: 'WEB' }, null, client)).toBe(rail));
});

describe('buildGrantReport — counted from the chain', () => {
  it('counts on-chain payments, applies the exclusions from AbaPay records, and names agents', async () => {
    const earmark = chain({ payer: W1, amount_usd: 2 });
    const mcp = chain({ payer: W2, amount_usd: 3, token_symbol: 'USD₮', rail: 'agent' });
    const unrecorded = chain({ payer: W3, amount_usd: 0.5 }); // on chain, no AbaPay order
    const web = chain({ payer: W2 });
    const own = chain({ payer: W2, rail: 'agent' });
    const refunded = chain({ payer: W1 });
    const relayerNoOrder = chain({ payer: W2, rail: 'agent' });
    db.tables.onchain_payments = [
      earmark, mcp, unrecorded, web, own, refunded, relayerNoOrder,
      chain({ payer: OURS }), // excluded wallet
      chain({ chain: 'BASE' }), // another chain
      chain({ rail: 'direct', payer: W1 }), // Earmark (a registered agent wallet) paying in the web app
      chain({ block_time: '2026-12-25T00:00:00Z' }), // outside the window
    ];
    const mcpOrder = order(mcp, { payment_method: 'AGENT_RELAY', source_channel: 'MCP' });
    db.tables.transactions = [
      order(earmark, {}), mcpOrder,
      order(web, { source_channel: 'WEB' }),
      order(own, { payment_method: 'AGENT_RELAY', source_channel: 'TELEGRAM' }),
      order(refunded, { status: 'REFUNDED' }),
    ];
    db.tables.payer_identities = [{ wallet: W1, erc8004_agents: [{ id: '9806', relation: 'owner', name: 'Earmark' }], self_verified: false }];
    db.tables.payment_client_info = [{ transaction_id: mcpOrder.id, declared_agent: null, client_diag: { protocol: 'MCP', auth: 'oauth', oauth_client_name: 'Claude', self_agent: { status: 'verified', agent_id: '42' } } }];
    db.tables.onchain_cursors = [{ chain: 'CELO', last_block: 81444642, updated_at: '2026-11-10T13:00:00Z' }];

    const r = await buildGrantReport(...WINDOW);
    expect(r.source).toBe('onchain');
    expect(r.onchain_total.payments).toBe(9); // every CELO payment in the window, every rail
    expect(r.totals).toEqual({ payments: 4, wallets: 3, volume_usd: 6.5, agents: 2 });
    expect(r.breakdown).toEqual({ recorded: 2, onchain_only: 2, unidentified_payments: 1 });
    expect(r.excluded).toEqual({ excluded_wallet: 1, abapay_web_app_or_own_agent: 2, app_payer_not_registered: 0, not_delivered: 1, relayer_without_order: 1 });
    expect(r.agents.find((a) => a.agent.startsWith('Earmark'))).toMatchObject({ integrations: ['x402', 'app'], payments: 2 });
    expect(r.agents.filter((a) => a.identified).map((a) => a.agent).sort()).toEqual(['Claude (OAuth client)', 'Earmark (ERC-8004 #9806)']);
    expect(r.agents.find((a) => !a.identified)).toMatchObject({ agent: 'Unidentified x402 payers (no AbaPay order)', payments: 1 });
    expect(r.agents.find((a) => a.agent.startsWith('Claude'))).toMatchObject({ integrations: ['MCP'], self_agent: 'verified #42' });
    expect(r.payments.find((p) => p.sender === W3)).toMatchObject({ onchain_only: true, amount: 0.5, recipient: VAULT });
    expect(r.indexed).toEqual({ block: 81444642, at: '2026-11-10T13:00:00Z' });
  });

  // An agent wallet can also pay in the web app. Once the chain shows it as a registered agent
  // (ERC-8004 or Self Agent ID) it counts as an agent wallet on every rail (owner's rule, 2026-11-21).
  it('counts a registered agent wallet paying in the web app, on any rail, and only registered ones', async () => {
    const selfOwner = chain({ payer: W2, rail: 'direct', amount_usd: 4 }); // Self Agent ID owner, web contract call
    const selfOwnerX402Web = chain({ payer: W2, amount_usd: 1 }); // the same wallet through the old web x402
    const selfOwnerChat = chain({ payer: W2, rail: 'agent', amount_usd: 2 }); // via AbaPay's own chat agent
    const person = chain({ payer: W3, rail: 'direct' }); // an unregistered web-app customer
    const personX402Web = chain({ payer: W3 });
    const ours = chain({ payer: OURS, rail: 'direct' }); // AbaPay's own wallet stays out whatever it holds
    db.tables.onchain_payments = [selfOwner, selfOwnerX402Web, selfOwnerChat, person, personX402Web, ours];
    db.tables.transactions = [
      order(selfOwner, { payment_method: null, x402_settle_tx: null, source_channel: 'WEB' }),
      order(selfOwnerX402Web, { source_channel: 'WEB' }),
      order(selfOwnerChat, { payment_method: 'AGENT_RELAY', source_channel: 'TELEGRAM' }),
      order(personX402Web, { source_channel: 'WEB' }),
    ];
    db.tables.payer_identities = [
      { wallet: W2, erc8004_agents: [], self_verified: true, self_agent_id: '205' },
      { wallet: OURS, erc8004_agents: [{ id: '9687', relation: 'owner', name: 'AbaPay' }], self_verified: true },
      { wallet: W3, erc8004_agents: [], self_verified: false },
    ];
    const r = await buildGrantReport(...WINDOW);
    expect(r.totals).toMatchObject({ payments: 3, wallets: 1, volume_usd: 7 });
    expect(r.payments.every((p) => p.sender === W2 && p.integration === 'app' && p.self_agent === 'verified #205 (wallet)')).toBe(true);
    expect(r.excluded).toMatchObject({ app_payer_not_registered: 1, abapay_web_app_or_own_agent: 1, excluded_wallet: 1 });
  });

  it('reads AbaPay records in pages short enough for a request URL', async () => {
    db.maxInList = 100;
    const rows = Array.from({ length: 250 }, (_, i) => chain({ payer: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
    db.tables.onchain_payments = rows;
    db.tables.transactions = rows.map((r) => order(r, {}));
    const r = await buildGrantReport(...WINDOW);
    expect(r.totals.payments).toBe(250);
  });

  it('takes the amount, token and time from the chain, not from AbaPay records', async () => {
    const p = chain({ payer: W1, amount_usd: 1.137364, token_symbol: 'USD₮', block_time: '2026-11-16T21:14:31Z' });
    db.tables.onchain_payments = [p];
    db.tables.transactions = [order(p, { amount_usdt: 999, token_used: 'USDC', created_at: '2026-11-20T00:00:00Z' })];
    const [pay] = (await buildGrantReport(...WINDOW)).payments;
    expect(pay).toMatchObject({ amount: 1.137364, token: 'USD₮', date: '2026-11-16T21:14:31Z', onchain_only: false });
  });

  it("counts an October agent payment stored as 'WEB', but not our web app's", async () => {
    const earmarkOct = chain({ payer: W1, amount_usd: 0.152515, block_time: '2026-11-16T19:39:00Z' });
    const webApp = chain({ payer: W2 });
    db.tables.onchain_payments = [earmarkOct, webApp];
    const eo = order(earmarkOct, { source_channel: 'WEB' });
    const wa = order(webApp, { source_channel: 'WEB' });
    db.tables.transactions = [eo, wa];
    db.tables.payment_client_info = [
      { transaction_id: eo.id, declared_agent: 'Earmark', declared_agent_id: '9806', user_agent: 'node', client_diag: null },
      { transaction_id: wa.id, declared_agent: null, declared_agent_id: null, user_agent: 'Mozilla/5.0 (Linux; Android 16)', client_diag: null },
    ];
    const r = await buildGrantReport(...WINDOW);
    expect(r.payments.map((p) => p.sender)).toEqual([W1]);
    expect(r.agents[0]).toMatchObject({ agent: 'Earmark', identified: true, payments: 1 });
    expect(r.excluded.abapay_web_app_or_own_agent).toBe(1);
  });

  it('never makes an agent of each unnamed wallet', async () => {
    db.tables.onchain_payments = Array.from({ length: 10 }, (_, i) => chain({ payer: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
    const r = await buildGrantReport(...WINDOW);
    expect(r.totals).toMatchObject({ payments: 10, wallets: 10, agents: 0 });
    expect(r.agents).toHaveLength(1);
    expect(r.met.agents).toBe(false);
  });

  it('marks the targets met', async () => {
    db.tables.onchain_payments = Array.from({ length: 1000 }, (_, i) => chain({ payer: `0x${(i % 30 + 1).toString(16).padStart(40, '0')}`, amount_usd: 1.5 }));
    const r = await buildGrantReport(...WINDOW);
    expect(r.totals.payments).toBe(1000);
    expect(r.totals.wallets).toBe(30);
    expect(r.met).toMatchObject({ payments: true, wallets: true, volume: true });
  });

  it('writes the CSV the final report attaches, saying which payments have an AbaPay order', async () => {
    const a = chain({ payer: W1, amount_usd: 2 });
    db.tables.onchain_payments = [a, chain({ payer: W3 })];
    db.tables.transactions = [order(a, {})];
    const csv = grantReportCsv(await buildGrantReport(...WINDOW));
    const [head, ...rows] = csv.trim().split('\n');
    expect(head).toBe('tx_hash,date,token,amount,sender,recipient,agent,integration,erc8004_id,self_agent,service,abapay_order,celoscan');
    expect(rows.find((l) => l.includes(W1))).toContain(',yes,https://celoscan.io/tx/0x');
    expect(rows.find((l) => l.includes(W3))).toContain(',no,https://celoscan.io/tx/0x');
  });
});
