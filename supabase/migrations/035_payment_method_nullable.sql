-- Align the repo with production: `transactions.payment_method` is NULLABLE with NO default.
--
-- 010 as committed says `not null default 'CONTRACT'`, but that is not what production got. There
-- the column is nullable, and direct contract-call payments (the original rail) are stored as
-- NULL: nothing in the app writes 'CONTRACT' (only 'X402' and 'AGENT_RELAY' are ever set), and
-- readers treat NULL as the contract rail (scripts/forensics coalesce it). Found by the schema
-- drift check (scripts/db-schema.mjs) when its build from migrations was compared with production.
--
-- In production this is a no-op. On a database built from the migrations it removes the default
-- and NOT NULL so that the result matches production.

alter table public.transactions alter column payment_method drop default;
alter table public.transactions alter column payment_method drop not null;
