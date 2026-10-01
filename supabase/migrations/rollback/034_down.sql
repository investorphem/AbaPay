-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 034_fulfilment_jobs.sql. Roll the application code back first (or set
-- FULFILMENT_WORKER_ENABLED=false): the worker reads these functions, and executeVend writes
-- vend_dispatched_at (it proceeds without the guard if the column is missing).

drop trigger if exists transactions_enqueue_fulfilment on public.transactions;
drop function if exists public.enqueue_fulfilment_job();
drop function if exists public.claim_jobs(integer);
drop function if exists public.complete_job(uuid);
drop function if exists public.fail_job(uuid, text, integer);
drop table if exists public.fulfilment_jobs;
alter table public.transactions drop column if exists vend_dispatched_at;
