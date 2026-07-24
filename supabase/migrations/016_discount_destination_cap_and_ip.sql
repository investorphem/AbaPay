-- 24h rolling cap per destination account (the phone/meter/account number being topped up) —
-- unlike the lifetime per-wallet cap, this resets daily: come back tomorrow and the same
-- number can get the discount again. Closes the "just switch wallets" loophole, since a real
-- abuser topping up the SAME destination from many different wallets is the actual tell —
-- rotating wallets alone no longer resets this particular allowance.
alter table public.discount_campaigns
  add column if not exists max_discount_per_destination_ngn numeric;

-- Best-effort client IP, captured ONLY on the web app's /api/pay path and ONLY when a discount
-- was actually applied (see src/lib/discounts.ts / src/app/api/pay/route.ts) — used purely to
-- flag suspicious clusters (many wallets, one IP, same active campaign) for manual admin
-- review. Never used to block anyone automatically.
alter table public.transactions
  add column if not exists client_ip text;
