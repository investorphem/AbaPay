-- Configurable discount/promo campaigns the operator can create, schedule, and monitor from
-- the admin dashboard — sits alongside (not instead of) the existing points system. A separate
-- table rather than more platform_settings columns because campaigns have a lifecycle (name,
-- start/end, history to look back on), unlike platform_settings' single always-current row.
create table if not exists public.discount_campaigns (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  type              text not null check (type in ('PERCENT', 'FIXED')),
  value             numeric not null check (value > 0),   -- percent (0-100) for PERCENT, naira for FIXED
  max_discount_ngn  numeric,                                 -- caps a PERCENT discount; ignored for FIXED
  -- Canonical service keys — the same set src/lib/serviceRules.ts's killSwitchKeyFor() already
  -- maps every intent/tab to: AIRTIME, INTERNET, ELECTRICITY, CABLE, BANK, EDUCATION.
  -- Null/empty = applies to every service.
  services          text[],
  starts_at         timestamptz,
  ends_at           timestamptz,
  is_active         boolean not null default true,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_discount_campaigns_active on public.discount_campaigns (is_active, starts_at, ends_at);
alter table public.discount_campaigns enable row level security;

-- Records exactly how much was discounted per transaction, for admin monitoring/reporting.
alter table public.transactions
  add column if not exists discount_ngn numeric not null default 0,
  add column if not exists discount_campaign_id uuid references public.discount_campaigns(id);
