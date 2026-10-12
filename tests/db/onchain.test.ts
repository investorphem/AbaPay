import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildDatabase } from '../../scripts/lib/buildDb.mjs';

// onchain_summary() (038) against a real Postgres: the numbers /agents/stats shows come straight
// from it, so its aggregates are tested here rather than through a fake.

let db: PGlite;
beforeAll(async () => {
  db = await buildDatabase();
  const rows: [string, string, number, string, string, number, string, string[]][] = [
    // chain, tx, log, time, payer, amount, rail, tags
    ['CELO', '0xa1', 0, '2026-10-01T10:00:00Z', '0xu1', 2.5, 'direct', ['celo_2719403c6aff', 'celo_9d71588659ec']],
    ['CELO', '0xa2', 0, '2026-10-01T11:00:00Z', '0xu2', 1.0, 'agent', ['celo_9d71588659ec']],
    ['CELO', '0xa3', 0, '2026-10-02T09:00:00Z', '0xu1', 0.5, 'x402', []],
    ['CELO', '0xa4', 0, '2026-10-02T09:30:00Z', '0xu3', 1.0, 'x402', []],
    ['BASE', '0xb1', 0, '2026-10-02T12:00:00Z', '0xu9', 10.0, 'direct', []],
  ];
  for (const [chain, tx, log, time, payer, amount, rail, tags] of rows) {
    await db.query(
      `insert into onchain_payments (chain, tx_hash, log_index, block_number, block_time, contract, contract_label, payer, token_address, token_symbol, amount_usd, rail, tags)
       values ($1, $2, $3, 1, $4, '0xvault', 'AbaPay V4 (current)', $5, '0xusdc', 'USDC', $6, $7, $8)`,
      [chain, tx, log, time, payer, amount, rail, tags],
    );
  }
  await db.query(`insert into onchain_cursors (chain, last_block, head_block) values ('CELO', 123, 130)`);
}, 60_000);
afterAll(async () => { await db?.close(); });

type Summary = {
  totals: { payments: number; wallets: number; volume_usd: number; agent_volume_usd: number };
  by_rail: { rail: string; payments: number }[];
  tags: { tag: string; payments: number }[];
  daily: { day: string; direct: number; agent: number; x402: number; wallets: number; new_wallets: number }[];
  cursors: { chain: string; last_block: number }[];
};
const summary = async (chain: string | null) =>
  (await db.query<{ s: Summary }>('select onchain_summary($1) as s', [chain])).rows[0].s;

describe('onchain_summary', () => {
  it('totals one chain without the other', async () => {
    const s = await summary('CELO');
    expect(s.totals).toMatchObject({ payments: 4, wallets: 3 });
    expect(Number(s.totals.volume_usd)).toBe(5);
    expect(Number(s.totals.agent_volume_usd)).toBe(2.5); // agent 1.0 + x402 1.5
    expect(s.cursors).toEqual([expect.objectContaining({ chain: 'CELO', last_block: 123 })]);
  });

  it('counts both chains when no chain is given', async () => {
    expect((await summary(null)).totals.payments).toBe(5);
  });

  it('splits days by rail and counts a wallet as new only on its first day', async () => {
    const s = await summary('CELO');
    expect(s.daily.map((d) => [d.day, d.direct, d.agent, d.x402, d.wallets, d.new_wallets])).toEqual([
      ['2026-10-01', 1, 1, 0, 2, 2],
      ['2026-10-02', 0, 0, 2, 2, 1], // 0xu1 returns, 0xu3 is new
    ]);
  });

  it('counts payments per attribution tag', async () => {
    const s = await summary('CELO');
    expect(s.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'celo_9d71588659ec', payments: 2 }),
      expect.objectContaining({ tag: 'celo_2719403c6aff', payments: 1 }),
    ]));
  });

  it('splits daily volume by rail (039)', async () => {
    const s = (await summary('CELO')) as unknown as { daily: { day: string; volume_direct: number; volume_agent: number; volume_x402: number }[] };
    expect(s.daily.map((d) => [d.day, Number(d.volume_direct), Number(d.volume_agent), Number(d.volume_x402)])).toEqual([
      ['2026-10-01', 2.5, 1, 0],
      ['2026-10-02', 0, 0, 1.5],
    ]);
  });

  it('groups contract payments by service and leaves x402 (no service on-chain) out (039)', async () => {
    await db.query('update onchain_payments set service_type = $1 where tx_hash in ($2, $3)', ['AIRTIME', '0xa1', '0xa2']);
    const s = (await summary('CELO')) as unknown as { by_service: { service_type: string; payments: number }[] };
    expect(s.by_service).toEqual([expect.objectContaining({ service_type: 'AIRTIME', payments: 2 })]);
  });

  it('is not callable, and the tables not readable, with the browser (anon) key', async () => {
    const grants = await db.query<{ ok: boolean }>(`select has_function_privilege('anon', 'public.onchain_summary(text)', 'execute') as ok`);
    expect(grants.rows[0].ok).toBe(false);
    const read = await db.query<{ ok: boolean }>(`select has_table_privilege('anon', 'public.onchain_payments', 'select') as ok`);
    expect(read.rows[0].ok).toBe(false);
  });
});
