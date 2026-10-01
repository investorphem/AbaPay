-- ============================================================
-- AbaPay — durable fulfilment: an outbox for proven payments (M6)
-- ============================================================
--
-- 🔴 WHAT WAS FRAGILE. Every rail (contract call, x402, webhook, agent relay, scheduler) claims
-- a proven payment PENDING -> PROCESSING and then calls the biller INSIDE the same HTTP
-- request. If that function dies between the claim and the biller call, the payer has paid and
-- nothing is delivered. The 5-minute sweep (reconcileStuck) finds the row, but when the biller
-- has no record of it, it can't tell "never sent" from "sent but the biller is slow". So it
-- stops and pages a human rather than risk delivering twice.
--
-- What this adds:
--   1. `vend_dispatched_at`: set by executeVend in ONE conditional update, immediately before
--      it calls the biller. Exactly one caller can win it, so the biller is called at most once
--      per payment whoever tries: the inline request, a retry or the worker. A PROCESSING row
--      without it was provably never sent, and is safe to send.
--   2. `fulfilment_jobs`: one row per proven payment, created by a TRIGGER in the same
--      transaction as the claim, whichever route performed it. A proven payment always has
--      exactly one job, which a worker (/api/internal/jobs/run) finishes if the request didn't.
--   3. claim_jobs / complete_job / fail_job: workers claim with FOR UPDATE SKIP LOCKED (two
--      workers never take the same job), retry with exponential backoff, and park a job as
--      `needs_review` after max attempts.
--
-- Jobs start 2 minutes in the future: the inline path normally finishes in seconds, so the
-- worker only ever sees payments the request didn't complete.

alter table public.transactions add column if not exists vend_dispatched_at timestamptz;

create table if not exists public.fulfilment_jobs (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  status         text not null default 'queued' check (status in ('queued', 'running', 'done', 'needs_review')),
  attempts       integer not null default 0,
  max_attempts   integer not null default 8,
  next_run_at    timestamptz not null default (now() + interval '2 minutes'),
  locked_at      timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists fulfilment_jobs_due_idx on public.fulfilment_jobs (status, next_run_at);

alter table public.fulfilment_jobs enable row level security;
-- No policies: service role only.

-- The outbox write. Fires on the claim itself (status entering PROCESSING with a real tx hash),
-- so it commits or rolls back with it.
create or replace function public.enqueue_fulfilment_job()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'PROCESSING'
     and (tg_op = 'INSERT' or old.status is distinct from 'PROCESSING')
     and coalesce(new.tx_hash, '') not like 'preflight_%' then
    insert into public.fulfilment_jobs (transaction_id) values (new.id)
    on conflict (transaction_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_enqueue_fulfilment on public.transactions;
create trigger transactions_enqueue_fulfilment
  after insert or update of status on public.transactions
  for each row execute function public.enqueue_fulfilment_job();

-- Claim up to p_limit due jobs. A `running` job whose worker died (locked > 10 min) is
-- reclaimed, so a crashed worker can't strand a job.
create or replace function public.claim_jobs(p_limit integer)
returns setof public.fulfilment_jobs
language sql
set search_path = public, pg_temp
as $$
  with picked as (
    select id from public.fulfilment_jobs
     where (status = 'queued' and next_run_at <= now())
        or (status = 'running' and locked_at < now() - interval '10 minutes')
     order by next_run_at
     limit greatest(1, least(p_limit, 50))
     for update skip locked
  )
  update public.fulfilment_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_at = now(), updated_at = now()
    from picked
   where j.id = picked.id
  returning j.*;
$$;

create or replace function public.complete_job(p_id uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.fulfilment_jobs set status = 'done', locked_at = null, last_error = null, updated_at = now() where id = p_id;
$$;

-- Reschedule after p_retry_seconds, or park as needs_review once max_attempts is reached.
-- Returns the job's new status.
create or replace function public.fail_job(p_id uuid, p_error text, p_retry_seconds integer)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  s text;
begin
  update public.fulfilment_jobs
     set status = case when attempts >= max_attempts then 'needs_review' else 'queued' end,
         next_run_at = now() + make_interval(secs => greatest(p_retry_seconds, 5)),
         locked_at = null,
         last_error = left(p_error, 500),
         updated_at = now()
   where id = p_id
  returning status into s;
  return s;
end;
$$;

revoke all on function public.claim_jobs(integer) from public, anon, authenticated;
revoke all on function public.complete_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text, integer) from public, anon, authenticated;

-- Backfill: every payment already sitting in PROCESSING gets its job now. Rows an operator was
-- already alerted about (STUCK_ALERTED) start as needs_review, so the worker doesn't re-run them.
insert into public.fulfilment_jobs (transaction_id, status, next_run_at)
select t.id,
       case when t.error_code = 'STUCK_ALERTED' then 'needs_review' else 'queued' end,
       now()
  from public.transactions t
 where t.status = 'PROCESSING' and coalesce(t.tx_hash, '') not like 'preflight_%'
on conflict (transaction_id) do nothing;
