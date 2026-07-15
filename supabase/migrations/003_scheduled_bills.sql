-- ============================================================
-- AbaPay — Scheduled Bills ("Bill Pay & Autopay Agent")
-- Run this once in the Supabase SQL editor.
-- ============================================================
--
-- Lets a user schedule a recurring bill ("pay my meter ₦2,000 on the 28th of every month").
-- On the due date the agent checks their on-chain stablecoin balance and:
--   • warns them ahead of time if the balance won't cover the bill (the #1 churn cause:
--     "forgot to top up, missed a bill"), and
--   • sends a one-tap, pre-filled payment link.
--
-- ⚠️ DESIGN NOTE — WHY THIS IS NOT AUTONOMOUS SPENDING:
-- AbaPay's contract uses transferFrom(msg.sender, …), so the payer MUST be the signer, and
-- AbaPay holds no key on the user's behalf (it is deliberately non-custodial). A schedule
-- therefore triggers a NOTIFICATION + one-tap link, not a silent debit. The user always
-- signs. Fully autonomous debit would require an on-chain spending allowance
-- (see AbaPayV2 + a `payBillFor` upgrade) and should not ship without an audit.

create table if not exists public.scheduled_bills (
  id                uuid primary key default gen_random_uuid(),
  wallet_address    text not null,

  -- What to pay
  service_id        text not null,          -- vtpass serviceID, e.g. 'ikeja-electric'
  service_category  text not null,          -- ELECTRICITY | AIRTIME | DATA | CABLE
  provider          text,                   -- display name
  billers_code      text not null,          -- meter / phone / smartcard
  amount_ngn        numeric not null,
  variation_code    text,
  meter_type        text,
  customer_name     text,
  customer_address  text,

  -- Chain preference for the payment link
  blockchain        text default 'CELO',
  token_used        text default 'USD₮',

  -- Schedule
  day_of_month      integer not null check (day_of_month between 1 and 28),
  is_active         boolean not null default true,

  -- Notification targets (any/all)
  notify_email      text,
  notify_telegram   text,                   -- telegram chat id

  -- Bookkeeping
  last_notified_at  timestamptz,
  last_paid_at      timestamptz,
  created_at        timestamptz not null default timezone('utc', now())
);

create index if not exists idx_scheduled_bills_wallet
  on public.scheduled_bills (wallet_address);

create index if not exists idx_scheduled_bills_due
  on public.scheduled_bills (day_of_month, is_active);

-- Only the backend (service-role key) touches this table; RLS with no permissive policy
-- means the public anon key cannot read or modify other users' schedules.
alter table public.scheduled_bills enable row level security;
