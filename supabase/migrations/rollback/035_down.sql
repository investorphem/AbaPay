-- Rollback for 035_payment_method_nullable.sql, for a database BUILT FROM THE MIGRATIONS only.
--
-- ⛔ Do not run this against production. 035 changed nothing there, so there is nothing to undo.
-- `payment_method` has always been nullable in production, contract-rail rows hold NULL, and
-- SET NOT NULL would fail on them.

alter table public.transactions alter column payment_method set default 'CONTRACT';
update public.transactions set payment_method = 'CONTRACT' where payment_method is null;
alter table public.transactions alter column payment_method set not null;
