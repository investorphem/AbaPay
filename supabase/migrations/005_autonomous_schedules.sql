-- Upgrades scheduled_bills for true autonomous execution and richer recurrence.
--
-- WHY THIS IS SAFE: with AbaPayV3 the user grants an ON-CHAIN spending allowance from their
-- own wallet. The contract refuses to exceed it. So a schedule can execute without the user
-- signing each time, while their maximum exposure remains exactly what they signed for.
-- auto_execute defaults to FALSE — autonomy is strictly opt-in, per schedule.

alter table public.scheduled_bills
  add column if not exists frequency text not null default 'monthly',   -- monthly | weekly | daily
  add column if not exists day_of_week integer check (day_of_week between 0 and 6),
  add column if not exists auto_execute boolean not null default false,
  add column if not exists last_run_date date,
  add column if not exists last_tx_hash text,
  add column if not exists consecutive_failures integer not null default 0;

alter table public.scheduled_bills alter column day_of_month drop not null;

create index if not exists idx_scheduled_bills_freq
  on public.scheduled_bills (frequency, is_active);
