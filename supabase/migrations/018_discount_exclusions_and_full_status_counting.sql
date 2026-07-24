-- Manual admin exclusions — set from the "Suspicious activity" panel after reviewing a flagged
-- IP/device cluster, to remove a specific wallet or destination account/meter from a specific
-- campaign going forward. Scoped per-campaign (not a global ban) so the same wallet can still
-- use a different, unrelated campaign. Enforced in src/lib/discounts.ts's computeDiscountNgn()
-- before anything else — an excluded match gets the normal, undiscounted price.
create table if not exists public.discount_exclusions (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.discount_campaigns(id) on delete cascade,
  wallet_address  text,
  account_number  text,
  reason          text,
  created_by      text,
  created_at      timestamptz not null default now(),
  constraint discount_exclusions_target_check check (wallet_address is not null or account_number is not null)
);

create index if not exists idx_discount_exclusions_campaign on public.discount_exclusions (campaign_id);
alter table public.discount_exclusions enable row level security;

-- Note: no schema change needed for counting failed/refunded transactions toward the discount
-- caps (src/lib/discounts.ts's COUNTED_STATUSES) — that's a query-filter change only, against
-- the existing transactions.status column.
