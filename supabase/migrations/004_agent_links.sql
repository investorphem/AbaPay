-- Links a wallet to a social channel (Telegram/WhatsApp/X) so the DeAI agent can recognise
-- the user and, if they've granted an on-chain allowance, pay their bills from it.
--
-- SECURITY: the spend cap that MATTERS is the on-chain allowance in
-- AbaPayV3.spendingAllowance. The columns here are a UX mirror only — NOT a security
-- control. Even if this table were fully compromised, the contract still refuses to spend
-- beyond what the user signed for on-chain.

create table if not exists public.agent_links (
  id                uuid primary key default gen_random_uuid(),
  wallet_address    text not null,
  channel           text not null check (channel in ('TELEGRAM','WHATSAPP','X')),
  channel_user_id   text not null,
  pin_hash          text not null,              -- scrypt, never plaintext
  link_code         text,
  link_verified     boolean not null default false,
  approved_token    text default 'USD₮',
  approved_chain    text default 'CELO',
  failed_pin_attempts integer not null default 0,
  locked_until      timestamptz,
  is_active         boolean not null default true,
  created_at        timestamptz not null default timezone('utc', now()),
  constraint agent_links_channel_user_unique unique (channel, channel_user_id)
);

create index if not exists idx_agent_links_wallet on public.agent_links (wallet_address);
create index if not exists idx_agent_links_lookup on public.agent_links (channel, channel_user_id);
alter table public.agent_links enable row level security;
