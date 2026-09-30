-- ============================================================
-- AbaPay — idempotency keys for money-moving MCP calls
-- ============================================================
--
-- pay_bill / pay_bill_batch / schedule_bill used to run again on every retry: an MCP client
-- that timed out waiting for the result and called again paid twice. src/lib/idempotency.ts
-- claims (scope, key) here before the call does anything, and stores the result once the call
-- has passed the point where money may move, so a repeat gets that result back instead.
--
--   scope        the credential (agent_links id, or a hash of the api_key) — never the raw key
--   key          "k:<tool>:<caller's idempotency_key>" or "d:<request hash>" (derived)
--   request_hash sha256 of the tool + arguments, WITHOUT pin/api_key — a repeat of the key
--                with different arguments is refused rather than answered with the old result
--   status       IN_PROGRESS while running, DONE once the result is stored
--
-- Expired rows are pruned by /api/cleanup.

create table if not exists public.idempotency_keys (
  scope        text not null,
  key          text not null,
  request_hash text not null,
  status       text not null check (status in ('IN_PROGRESS', 'DONE')),
  response     jsonb,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  primary key (scope, key)
);

create index if not exists idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

alter table public.idempotency_keys enable row level security;
-- No policies: service role only.
