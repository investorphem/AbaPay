#!/usr/bin/env node
// 🗄️ DB SCHEMA DRIFT CHECK (M0.5 / M7). Builds a fresh Postgres from supabase/migrations
// (000_baseline → newest) inside PGlite (real Postgres compiled to WASM: no Docker, no Supabase
// CLI), describes the resulting public schema as one sorted line per object, and compares it with
// the committed supabase/schema.snapshot.txt.
//
// Why it matters: before 000_baseline existed, eight tables lived only in production, so no clean
// database could be built from the repo and nothing noticed when a migration and production
// disagreed. Now a migration that changes the schema has to change the snapshot in the same PR,
// where a reviewer sees exactly which columns, policies and grants moved.
//
//   node scripts/db-schema.mjs           check (CI). Fails if the migrations' schema ≠ snapshot.
//   node scripts/db-schema.mjs --update  rewrite the snapshot after adding a migration.
//   node scripts/db-schema.mjs --query   print the describe query. Run it against PRODUCTION
//                                        (read-only) and diff the output with the snapshot to
//                                        catch drift between the repo and the live database.
import { buildDatabase, migrationFiles } from './lib/buildDb.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SNAPSHOT = path.resolve('supabase/schema.snapshot.txt');

// One line per object, order-independent (column positions differ between a database built in
// one go and one that grew by ALTERs, so position is deliberately left out). Function bodies are
// compared by a hash of their source with `--` comments removed and whitespace collapsed (production's
// copies were pasted into the SQL editor without the comments). Two things newer Postgres records that
// production's PG15 doesn't are filtered so the two compare like for like: NOT NULL as a
// constraint row (the column line already says `not null`) and the MAINTAIN privilege.
export const DESCRIBE = `
with rel as (
  select c.oid, c.relname, c.relrowsecurity from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
), roles(r) as (values ('anon'), ('authenticated'), ('service_role'))
select line from (
  select format('table %s rls=%s', relname, relrowsecurity) as line from rel
  union all
  select format('column %s.%s %s%s%s', r.relname, a.attname, format_type(a.atttypid, a.atttypmod),
    case when a.attnotnull then ' not null' else '' end,
    coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''))
  from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = r.oid and d.adnum = a.attnum
  union all
  select format('constraint %s.%s %s', r.relname, c.conname, pg_get_constraintdef(c.oid))
  from rel r join pg_constraint c on c.conrelid = r.oid and c.contype <> 'n'
  union all
  select format('index %s.%s %s', tablename, indexname, indexdef) from pg_indexes where schemaname = 'public'
  union all
  select format('trigger %s.%s %s', r.relname, t.tgname, pg_get_triggerdef(t.oid))
  from rel r join pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal
  union all
  select format('policy %s.%s %s %s to %s using (%s) check (%s)', tablename, policyname, permissive, cmd,
    array_to_string(roles, ','), coalesce(qual, ''), coalesce(with_check, ''))
  from pg_policies where schemaname = 'public'
  union all
  select format('function %s(%s) returns %s lang=%s secdef=%s config=%s body=%s', p.proname,
    pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), l.lanname, p.prosecdef,
    coalesce(array_to_string(p.proconfig, ';'), ''), md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', ' ', 'g'))))
  from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace = 'public'::regnamespace
  union all
  select format('grant %s on %s to %s', string_agg(g.privilege_type, ',' order by g.privilege_type), g.table_name, g.grantee)
  from information_schema.role_table_grants g join roles on roles.r = g.grantee
  where g.table_schema = 'public' and g.privilege_type <> 'MAINTAIN' group by g.table_name, g.grantee
  union all
  select format('grant execute on %s(%s) to %s', p.proname, pg_get_function_identity_arguments(p.oid),
    case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end)
  from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  where p.pronamespace = 'public'::regnamespace and x.privilege_type = 'EXECUTE'
    and (x.grantee = 0 or x.grantee::regrole::text in (select r from roles))
) s order by line;
`;

if (process.argv.includes('--query')) {
  process.stdout.write(DESCRIBE.trim() + '\n');
  process.exit(0);
}

const files = migrationFiles();
let db;
try {
  db = await buildDatabase();
} catch (e) {
  console.error(`::error file=supabase/migrations/${e.migration}::migration failed on a fresh database: ${e.message}`);
  process.exit(1);
}
const { rows } = await db.query(DESCRIBE);
const current = rows.map((r) => r.line).join('\n') + '\n';
await db.close();

if (process.argv.includes('--update')) {
  fs.writeFileSync(SNAPSHOT, current);
  console.log(`Snapshot written: ${rows.length} objects from ${files.length} migrations.`);
  process.exit(0);
}

const expected = fs.existsSync(SNAPSHOT) ? fs.readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n') : '';
if (current === expected) {
  console.log(`DB schema OK: ${files.length} migrations apply cleanly and match the snapshot (${rows.length} objects).`);
  process.exit(0);
}
const want = new Set(expected.split('\n').filter(Boolean));
const have = new Set(current.split('\n').filter(Boolean));
for (const l of [...want].filter((l) => !have.has(l))) console.error(`- ${l}`);
for (const l of [...have].filter((l) => !want.has(l))) console.error(`+ ${l}`);
console.error('\n::error::The migrations no longer produce supabase/schema.snapshot.txt (- snapshot only, + migrations only).');
console.error('If the change is intended, run `npm run db:schema -- --update` and commit the snapshot with the migration.');
process.exit(1);
