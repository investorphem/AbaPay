-- Records WHERE a transaction originated, so operator alerts can distinguish
-- "via TELEGRAM agent" from "the web app" from "an unattended autonomous schedule".
-- Those carry very different risk profiles.

alter table public.transactions
  add column if not exists source_channel text default 'WEB';   -- WEB|TELEGRAM|WHATSAPP|X|SCHEDULE

create index if not exists idx_transactions_source_channel
  on public.transactions (source_channel);
