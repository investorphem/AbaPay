-- ⚡ ENTERPRISE REFUND PIPELINE
--
-- When VTpass fails AFTER we've taken the user's crypto, the money is in our vault and the
-- user got nothing. Previously this sat as FAILED_VENDING until a human noticed. That does
-- not scale, and is unacceptable once an AGENT transacts unattended — a user could be
-- auto-charged at 3am for a service that failed, with nobody watching.
--
-- WHY NOT FULLY AUTOMATIC? refundUser() is onlyOwner, deliberately. Giving the relayer hot
-- key power to send vault funds to arbitrary addresses would turn a bounded, capped key into
-- one that can drain the treasury. Money ENTERING the vault is capped on-chain and safe to
-- automate; money LEAVING it keeps a human in the loop. That asymmetry is intentional.

create table if not exists public.refund_queue (
  id                uuid primary key default gen_random_uuid(),
  transaction_id    uuid references public.transactions(id),
  tx_hash           text not null unique,       -- unique => a retrying webhook can't double-queue
  wallet_address    text not null,
  token_used        text not null,
  amount_crypto     numeric not null,
  amount_naira      numeric,
  blockchain        text not null default 'CELO',
  reason            text not null,
  vtpass_error      text,
  service_category  text,
  source_channel    text default 'WEB',
  status            text not null default 'PENDING',   -- PENDING|APPROVED|COMPLETED|REJECTED|FAILED
  refund_tx_hash    text,
  approved_by       text,
  approved_at       timestamptz,
  completed_at      timestamptz,
  notes             text,
  user_notified     boolean not null default false,
  created_at        timestamptz not null default timezone('utc', now())
);

create index if not exists idx_refund_queue_status on public.refund_queue (status, created_at);
create index if not exists idx_refund_queue_wallet on public.refund_queue (wallet_address);
alter table public.refund_queue enable row level security;
