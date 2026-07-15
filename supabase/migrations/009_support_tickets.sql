-- Support tickets from the web app AND every social channel.
--
-- A user who paid via Telegram and hit a problem should get help right there, not be told to
-- go somewhere else. The operator replies from the admin dashboard and the answer lands back
-- in the user's original chat.

create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  wallet_address  text,
  channel         text not null default 'WEB',     -- WEB|TELEGRAM|WHATSAPP|X
  channel_user_id text,                            -- so we can reply in their chat
  customer_email  text,
  subject         text,
  message         text not null,
  tx_hash         text,                            -- optional: the transaction in question
  status          text not null default 'OPEN',    -- OPEN|ANSWERED|CLOSED
  admin_reply     text,
  replied_by      text,
  replied_at      timestamptz,
  created_at      timestamptz not null default timezone('utc', now())
);

create index if not exists idx_support_status on public.support_tickets (status, created_at);
create index if not exists idx_support_wallet on public.support_tickets (wallet_address);
alter table public.support_tickets enable row level security;
