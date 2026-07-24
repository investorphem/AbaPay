-- Two independent spend caps on top of the existing per-transaction max_discount_ngn:
--   • max_discount_per_wallet_ngn — lifetime discount ceiling for a single wallet under this
--     campaign (stops one address from repeatedly draining a promo).
--   • max_total_discount_ngn — lifetime discount ceiling across the WHOLE campaign; once the
--     cumulative discount given (successful transactions only) reaches it, the campaign stops
--     matching entirely and transactions fall back to the normal, undiscounted flow — no manual
--     deactivation needed. Enforced lazily in src/lib/discounts.ts, not by a scheduled job.
alter table public.discount_campaigns
  add column if not exists max_discount_per_wallet_ngn numeric,
  add column if not exists max_total_discount_ngn numeric;
