-- Rollback for 038_onchain_payments.sql. The data is a cache of the chain: the indexer rebuilds
-- it from scratch if 038 is re-applied, so dropping it loses nothing that can't be re-read.

drop function if exists public.onchain_summary(text);
drop table if exists public.onchain_cursors;
drop table if exists public.onchain_payments;
