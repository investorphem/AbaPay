-- ============================================================
-- AbaPay — inbound webhook de-duplication
-- ============================================================
--
-- Telegram, WhatsApp (Meta) and X all redeliver a webhook they think failed — a slow reply,
-- a timeout, a 5xx — and they do it with the SAME message id. Nothing recorded those ids, so
-- a redelivery was processed as a brand-new message: a second reply, and, if it was the PIN
-- that confirmed a payment, a second attempt at the payment (the session claim in
-- /api/deai/core stops the second payment; this stops the second processing altogether).
--
-- One row per delivery, unique on (source, external_id). src/lib/webhookEvents.ts inserts
-- first; a 23505 means "already seen" and the route answers 200 without doing anything.
-- Rows older than 7 days are pruned by /api/cleanup — every platform stops retrying long
-- before that.

create table if not exists public.webhook_events (
  source       text not null,
  external_id  text not null,
  received_at  timestamptz not null default now(),
  primary key (source, external_id)
);

create index if not exists webhook_events_received_at_idx on public.webhook_events (received_at);

alter table public.webhook_events enable row level security;
-- No policies: service role only, like every other server-side table.
