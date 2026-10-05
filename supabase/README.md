# Database migrations

`migrations/` builds the whole `public` schema, in filename order, on an empty Postgres.

## `000_baseline.sql`: never apply it to production

Eight tables (`transactions`, `platform_settings`, `abapay_users`, `abapay_global_users`,
`wallet_links`, `deai_identities`, `deai_sessions`, `otp_requests`) and two functions
(`award_transaction_points`, `link_wallet_to_phone`) were created by hand in production before
the repo kept migrations. `000_baseline.sql` recreates them as they were before `001`, so a clean
database can be built from the repo. Production already has all of it. The file is idempotent,
but there is no reason to run it there.

There is no `013`. That number was never used.

## Schema drift check

```bash
npm run db:schema               # CI: build 000 → newest in PGlite, compare with schema.snapshot.txt
npm run db:schema -- --update   # after adding a migration: rewrite the snapshot, commit both
npm run db:schema -- --query    # print the describe query
```

`schema.snapshot.txt` lists one line per table, column, constraint, index, trigger, policy,
function and grant, sorted. A migration that changes the schema shows up in review as a diff to
that file. The check runs in-process on [PGlite](https://pglite.dev) (Postgres compiled to
WASM), so it needs no Docker or Supabase CLI. It stubs the `anon`, `authenticated` and
`service_role` roles and Supabase's default grants.

### Checking production against the repo

Run the output of `--query` against production (read-only) and compare it line by line with
`schema.snapshot.txt`. They matched exactly on 2026-10-05, after `035` aligned
`transactions.payment_method` with what production actually has. Any difference means a change
was made in the dashboard without a migration, or a migration was never applied.

## Adding a migration

1. Use the next free number (`036_…`). Never edit one that has been applied.
2. Follow the conventions: `set search_path = public, pg_temp` on functions, revoke `EXECUTE` from
   `public, anon, authenticated` on new functions, and enable RLS with no permissive policies on new
   tables. Put a matching `rollback/NNN_down.sql` beside it.
3. Run `npm run db:schema -- --update`, check the snapshot diff is what you meant, and commit both.
