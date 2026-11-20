import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// 🔁 Every x402/relayer payer is re-read from the chain on a rolling basis
// (src/lib/onchain/payerRecheck.ts), so a wallet that registered as an agent after paying — FIN,
// ERC-8004 #10006, paid on 2026-10-30 without naming itself — gets named.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));

const chainSays: Record<string, { agents: { id: string; relation: string; name?: string }[]; self?: boolean; error?: string } | Error> = {};
const looked: string[] = [];
vi.mock('@/lib/payerIdentity', () => ({
  lookupPayerIdentity: async (w: string) => {
    looked.push(w);
    const c = chainSays[w];
    if (c instanceof Error) throw c;
    return {
      wallet: w, erc8004_agents: c?.agents ?? [], self_verified: c?.self ?? false, self_agent_id: null,
      self_human_proof: null, self_proof_fresh: null, checked_at: new Date(NOW).toISOString(), lookup_error: c?.error ?? null,
    };
  },
}));

const { recheckAgentPayers } = await import('@/lib/onchain/payerRecheck');

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HOURS = 3600_000;
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const pay = (payer: string, rail = 'x402') => ({ chain: 'CELO', payer, rail, block_time: '2026-11-01T00:00:00Z', tx_hash: `0x${Math.random().toString(16).slice(2)}`, log_index: 0 });
const identity = (wallet: string, checkedHoursAgo: number, over: Record<string, unknown> = {}) => ({
  wallet, erc8004_agents: [], self_verified: false, checked_at: new Date(NOW - checkedHoursAgo * HOURS).toISOString(), lookup_error: null, ...over,
});

beforeEach(() => {
  db = createFakeDb({ onchain_payments: [], payer_identities: [] });
  looked.length = 0;
  for (const k of Object.keys(chainSays)) delete chainSays[k];
});

describe('recheckAgentPayers', () => {
  it('re-reads payers on every rail (the web app included), never-checked first, then the stalest; skips fresh ones', async () => {
    db.tables.onchain_payments = [pay(w(1)), pay(w(2)), pay(w(2)), pay(w(3), 'agent'), pay(w(4)), pay(w(9), 'direct')];
    db.tables.payer_identities = [identity(w(1), 30), identity(w(2), 2), identity(w(3), 50)];
    const r = await recheckAgentPayers({ now: NOW });
    expect(r).toMatchObject({ payers: 5, due: 4, checked: 4, errors: 0 });
    expect(looked).toEqual([w(4), w(9), w(3), w(1)]); // never checked (w(9) paid in the web app), then 50h, then 30h; w(2) is fresh
  });

  it('reports a wallet that registered as an agent after it paid (FIN)', async () => {
    const fin = '0x96b2b08cd63683bd82c1285705d26e2cd053dc7d';
    db.tables.onchain_payments = [pay(fin)];
    db.tables.payer_identities = [identity(fin, 48)];
    chainSays[fin] = { agents: [{ id: '10006', relation: 'owner', name: 'FIN-PortfolioSentinel-Vanguard' }] };
    const r = await recheckAgentPayers({ now: NOW });
    expect(r.newly_identified).toEqual([fin]);
    expect(db.tables.payer_identities.find((p) => p.wallet === fin)).toMatchObject({ erc8004_agents: [{ id: '10006' }] });
  });

  it('does not report a wallet that was already identified', async () => {
    db.tables.onchain_payments = [pay(w(1))];
    db.tables.payer_identities = [identity(w(1), 30, { erc8004_agents: [{ id: '9806', relation: 'owner' }] })];
    chainSays[w(1)] = { agents: [{ id: '9806', relation: 'owner' }] };
    expect((await recheckAgentPayers({ now: NOW })).newly_identified).toEqual([]);
  });

  it('does not alert on a first-ever read, only names the wallet', async () => {
    db.tables.onchain_payments = [pay(w(5))];
    chainSays[w(5)] = { agents: [{ id: '777', relation: 'owner' }] };
    const r = await recheckAgentPayers({ now: NOW });
    expect(r.newly_identified).toEqual([]);
    expect(db.tables.payer_identities.find((p) => p.wallet === w(5))).toMatchObject({ erc8004_agents: [{ id: '777' }] });
  });

  it("never alerts for AbaPay's own or excluded wallets", async () => {
    const owner = '0x9999999999999999999999999999999999999999';
    process.env.GRANT_EXCLUDED_WALLETS = owner;
    db.tables.onchain_payments = [pay(owner)];
    db.tables.payer_identities = [identity(owner, 48)];
    chainSays[owner] = { agents: [{ id: '9687', relation: 'owner' }] };
    expect((await recheckAgentPayers({ now: NOW })).newly_identified).toEqual([]);
    delete process.env.GRANT_EXCLUDED_WALLETS;
  });

  it('a half-failed lookup keeps the known identity, so the next clean read is not a second alert', async () => {
    db.tables.onchain_payments = [pay(w(6))];
    db.tables.payer_identities = [identity(w(6), 48, { erc8004_agents: [{ id: '10006', relation: 'owner' }] })];
    chainSays[w(6)] = { agents: [], error: 'erc8004 ids: blockscout down' }; // empty because the read failed
    const r1 = await recheckAgentPayers({ now: NOW });
    expect(r1).toMatchObject({ checked: 0, errors: 1, newly_identified: [] });
    expect(db.tables.payer_identities.find((p) => p.wallet === w(6))?.erc8004_agents).toEqual([{ id: '10006', relation: 'owner' }]);

    chainSays[w(6)] = { agents: [{ id: '10006', relation: 'owner' }] }; // a clean read later
    expect((await recheckAgentPayers({ now: NOW })).newly_identified).toEqual([]);
  });

  it('retries a check that errored before, and keeps going when one lookup fails', async () => {
    db.tables.onchain_payments = [pay(w(1)), pay(w(2))];
    db.tables.payer_identities = [identity(w(1), 1, { lookup_error: 'rpc timeout' })];
    chainSays[w(2)] = new Error('rpc down');
    const r = await recheckAgentPayers({ now: NOW });
    expect(looked.sort()).toEqual([w(1), w(2)]);
    expect(r).toMatchObject({ checked: 1, errors: 1 });
  });

  it('stops at the batch size', async () => {
    db.tables.onchain_payments = Array.from({ length: 30 }, (_, i) => pay(w(i + 1)));
    const r = await recheckAgentPayers({ now: NOW, batch: 5 });
    expect(r).toMatchObject({ payers: 30, due: 30, checked: 5 });
  });

  // Production: 432 payers, `due` stuck at 432 on every run, the same 20 wallets re-read forever.
  // One `in` list of 500 wallets made the request URL too long, the error was ignored, and every
  // wallet looked never-checked.
  it('reads every payer\'s last check in pages short enough for a request URL, so fresh wallets are not re-read', async () => {
    db.maxInList = 100;
    db.tables.onchain_payments = Array.from({ length: 250 }, (_, i) => pay(w(i + 1)));
    db.tables.payer_identities = Array.from({ length: 250 }, (_, i) => identity(w(i + 1), i < 240 ? 2 : 30));
    const r = await recheckAgentPayers({ now: NOW });
    expect(r).toMatchObject({ payers: 250, due: 10, checked: 10, errors: 0 });
    expect(looked).toEqual(Array.from({ length: 10 }, (_, i) => w(241 + i)));
  });

  it('moves on: the next run re-reads different wallets than the last one', async () => {
    db.maxInList = 100;
    db.tables.onchain_payments = Array.from({ length: 150 }, (_, i) => pay(w(i + 1)));
    db.tables.payer_identities = Array.from({ length: 150 }, (_, i) => identity(w(i + 1), 30));
    await recheckAgentPayers({ now: NOW, batch: 20 });
    const first = [...looked];
    looked.length = 0;
    await recheckAgentPayers({ now: NOW, batch: 20 });
    expect(looked).toHaveLength(20);
    expect(looked.filter((x) => first.includes(x))).toEqual([]);
  });

  it('fails loudly instead of treating every wallet as never checked when the checks can\'t be read', async () => {
    db.maxInList = 2; // the rail filter (2 values) passes; the 3-wallet identity read fails
    db.tables.onchain_payments = [pay(w(1)), pay(w(2)), pay(w(3))];
    await expect(recheckAgentPayers({ now: NOW })).rejects.toThrow(/payer_identities read failed/);
  });
});
