-- Textile FX conversions and cNGN payouts for verified agents (src/lib/textileFx.ts,
-- src/lib/cngnPayout.ts).
--
-- A verified agent paying a naira transfer pays in USD stablecoins. AbaPay's FX wallet then buys
-- exactly that many naira of cNGN on Textile FX (one RFQ swap on Celo, carrying AbaPay's
-- attribution tags) and delivers it: to the vault for a bank transfer, or straight to the
-- recipient's wallet for a cNGN transfer. Every switch starts off.
--
--   fx_enabled              convert on Textile FX at all
--   fx_max_usd_per_tx       the most one conversion may sell (USD₮)
--   fx_daily_cap_usd        the most the FX wallet may sell in 24 hours
--   cngn_payout_enabled     verified agents may send cNGN to a wallet
alter table public.platform_settings
  add column if not exists fx_enabled boolean not null default false,
  add column if not exists fx_max_usd_per_tx numeric not null default 200 check (fx_max_usd_per_tx > 0),
  add column if not exists fx_daily_cap_usd numeric not null default 500 check (fx_daily_cap_usd > 0),
  add column if not exists cngn_payout_enabled boolean not null default false;

-- One row per order that needed a conversion. `purpose` says where the cNGN goes. Amounts are in
-- atomic units (both tokens have 6 decimals). The swap and the delivery are separate transactions.
create table if not exists public.fx_conversions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete restrict,
  purpose text not null check (purpose in ('BANK_TREASURY', 'CNGN_PAYOUT')),
  recipient text not null,
  cngn_amount numeric not null check (cngn_amount > 0),
  usd_sold numeric,
  rfq_id text,
  swap_tx text,
  delivery_tx text,
  status text not null default 'PENDING' check (status in ('PENDING', 'SWAPPED', 'DELIVERED', 'FAILED')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fx_conversions_created_idx on public.fx_conversions (created_at);

alter table public.fx_conversions enable row level security;
revoke all on table public.fx_conversions from public, anon, authenticated;
grant all on table public.fx_conversions to service_role;
