import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { buildDatabase } from '../../scripts/lib/buildDb.mjs';

// Database tests against a REAL Postgres: every migration applied in PGlite (in-process, no Docker),
// so SQL functions, triggers and constraints are tested as production runs them, not via fakes.

let db: PGlite;
beforeAll(async () => { db = await buildDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const num = (v: unknown) => Number(v);

describe('supabase/tests/*.sql', () => {
  // These were written to be run by hand in the SQL editor, and never ran in CI. Each raises (and
  // so fails here) on the first case that doesn't hold.
  const dir = path.resolve('supabase/tests');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    it(f, async () => {
      await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    });
  }
});

describe('points', () => {
  const WALLET = '0xabc0000000000000000000000000000000000001';
  const PHONE = '+2348012345678';

  it('award_transaction_points banks fractional points on an unlinked wallet', async () => {
    await db.query('select award_transaction_points($1, $2)', [WALLET, 1.34]);
    await db.query('select award_transaction_points($1, $2)', [WALLET, 0.5]);
    expect(num((await one<{ unclaimed_points: string }>('select unclaimed_points from wallet_links where wallet_address = $1', [WALLET]))!.unclaimed_points)).toBe(1.84);
  });

  it('link_wallet_to_phone moves ALL of them, fractions included, to the phone profile', async () => {
    await db.query('select link_wallet_to_phone($1, $2)', [WALLET, PHONE]);
    const profile = await one<{ total_points: string }>('select total_points from abapay_users where verified_phone = $1', [PHONE]);
    const link = await one<{ unclaimed_points: string; user_id: string | null }>('select unclaimed_points, user_id from wallet_links where wallet_address = $1', [WALLET]);
    expect(num(profile!.total_points)).toBe(1.84);
    expect(num(link!.unclaimed_points)).toBe(0);
    expect(link!.user_id).not.toBeNull();
  });

  it('points earned after linking go straight to the profile', async () => {
    await db.query('select award_transaction_points($1, $2)', [WALLET, 2.25]);
    expect(num((await one<{ total_points: string }>('select total_points from abapay_users where verified_phone = $1', [PHONE]))!.total_points)).toBe(4.09);
  });

  it('still caps a phone at three wallets', async () => {
    for (let i = 2; i <= 3; i++) await db.query('select link_wallet_to_phone($1, $2)', [`0xabc000000000000000000000000000000000000${i}`, PHONE]);
    await expect(db.query('select link_wallet_to_phone($1, $2)', ['0xabc0000000000000000000000000000000000004', PHONE]))
      .rejects.toThrow(/Maximum of 3 wallets/);
  });
});
