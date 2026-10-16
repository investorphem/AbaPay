-- Rollback for 044: drops the payer identity cache and per-payment client info. Payments are
-- unaffected; the admin ledger just stops showing who the agent was.

drop table if exists public.payment_client_info;
drop table if exists public.payer_identities;
