-- The NIM discount (nim.abapays.com, the Nimiq Pay mini app; /api/pay/nim).
--
-- One switch and one percentage, set from the admin Discounts tab and separate from the
-- discount_campaigns that abapays.com uses. While it is on, every NIM order is discounted by the
-- percentage, on the bill's face value (fees are charged in full, as a campaign does). While it is
-- off, NIM orders are priced exactly as before. NIM orders never take a discount_campaigns
-- discount: the operator controls the two separately.
--
-- Below 100: a 100% discount would make the NIM owed zero, and a zero payment can't be found or
-- verified on the Nimiq chain (settlement matches the treasury, the amount and the reference).
alter table public.platform_settings
  add column if not exists nim_discount_enabled boolean not null default false,
  add column if not exists nim_discount_percent numeric not null default 0
    check (nim_discount_percent >= 0 and nim_discount_percent < 100);

-- The percentage a row was discounted by, so the customer's history and receipt can say "10% off"
-- even after the admin changes or switches off the discount. Null when no percentage applied.
alter table public.transactions add column if not exists discount_percent numeric;
