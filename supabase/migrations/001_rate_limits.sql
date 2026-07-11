-- ============================================================
-- AbaPay — rate limiting support table
-- Run this once in the Supabase SQL editor.
-- ============================================================
--
-- Backs src/lib/rateLimit.ts. Rate-limit state MUST be shared across serverless
-- instances (an in-memory counter on Vercel resets on every cold start and is
-- per-instance, so it provides no real protection).

create table if not exists public.rate_limits (
  key           text primary key,
  count         integer not null default 0,
  window_start  timestamptz not null default now()
);

-- Lets the cleanup below run efficiently.
create index if not exists idx_rate_limits_window_start
  on public.rate_limits (window_start);

-- This table is only ever touched by the backend using the service-role key,
-- which bypasses RLS. Enabling RLS with no permissive policy means the public
-- anon key cannot read or tamper with rate-limit counters.
alter table public.rate_limits enable row level security;

-- ------------------------------------------------------------
-- OPTIONAL HOUSEKEEPING
-- Old buckets are harmless (they're ignored once their window elapses), but
-- pruning keeps the table small. Run occasionally, or wire into a scheduled job.
-- ------------------------------------------------------------
-- delete from public.rate_limits where window_start < now() - interval '1 day';
