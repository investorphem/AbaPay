-- Upgrades scheduled_bills to support ONE-OFF future execution ("buy me MTN airtime in
-- the next 10 minutes"), alongside the existing recurring (monthly/weekly/daily) schedules.
--
-- `frequency` gains a new value: 'once'. A 'once' row fires exactly one time, at
-- `run_once_at`, then deactivates itself — there is no "next scheduled date" to wait for.
--
-- `batch_id` groups multiple rows created from a single chat request that named several
-- recipients ("send airtime to 08011111111 and 08022222222") — purely a reporting label so
-- the app/admin can show them together; each row still executes and vends independently.

alter table public.scheduled_bills
  add column if not exists run_once_at timestamptz,
  add column if not exists batch_id uuid;

create index if not exists idx_scheduled_bills_run_once
  on public.scheduled_bills (run_once_at)
  where frequency = 'once';

create index if not exists idx_scheduled_bills_batch
  on public.scheduled_bills (batch_id)
  where batch_id is not null;
