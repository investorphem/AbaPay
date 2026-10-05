// Builds a fresh Postgres from supabase/migrations (000_baseline → newest) in PGlite: real
// Postgres compiled to WASM, in-process, so no Docker or Supabase CLI. Shared by the schema drift
// check (scripts/db-schema.mjs) and the database tests (tests/db/*.test.ts).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_DIR = path.resolve('supabase/migrations');

// The parts of a Supabase project the migrations lean on but don't create: its API roles, and
// the default privileges that hand every new table and function to them (RLS and the migrations'
// own REVOKEs are what then lock things down, exactly as in production).
const SUPABASE_BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}.*\.sql$/.test(f)).sort();
}

/** A new in-memory database with every migration applied. Throws naming the file that failed. */
export async function buildDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE_BOOTSTRAP);
  for (const f of migrationFiles()) {
    try {
      await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    } catch (e) {
      await db.close();
      throw Object.assign(new Error(`${f}: ${e.message}`), { migration: f });
    }
  }
  return db;
}
