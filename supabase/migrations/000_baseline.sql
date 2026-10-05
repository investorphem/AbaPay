-- ============================================================
-- AbaPay — 000 BASELINE (implementation plan M0.5)
-- ⛔ NEVER APPLY THIS TO PRODUCTION. Production already has all of it.
-- ============================================================
--
-- These eight tables and two functions were created by hand in the Supabase dashboard before
-- the repo kept migrations, so they existed ONLY in production and no clean database could be
-- built from supabase/migrations. This file recreates them, as read from the production catalog
-- on 2026-10-05 (schema only, no data), in the shape they had BEFORE 001: every column, index,
-- policy and trigger that a later migration adds is left to that migration.
--
-- It exists so `npm run db:schema` (scripts/db-schema.mjs, run in CI) can build
-- 000 → newest on a fresh Postgres and compare the result with supabase/schema.snapshot.txt.
-- Everything is idempotent, so running it against a database that has the tables is a no-op.
--
-- Not reproduced, deliberately: the four `USING (true)` policies `transactions` had in
-- production until 025 dropped them (they are documented there). Recreating them only for 025
-- to remove would put that hole back into any database built from this file and stopped early.

set search_path = public, pg_temp;

-- ── Phone-verified points profile and the wallets linked to it ──────────────────────────────
create table if not exists public.abapay_users (
  id             uuid primary key default gen_random_uuid(),
  verified_phone text not null unique,
  total_points   numeric(10,2) not null default 0,
  created_at     timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.wallet_links (
  wallet_address   text primary key,
  user_id          uuid references public.abapay_users(id),
  unclaimed_points numeric(10,2) not null default 0,
  linked_at        timestamptz
);

-- ── DeAI (chat channels) identities and pending-confirmation sessions ───────────────────────
create table if not exists public.abapay_global_users (
  id               uuid primary key default gen_random_uuid(),
  wallet_address   text unique,
  email            text unique,
  phone_number     text unique,
  password_hash    text,
  fiat_balance_ngn numeric(15,2) default 0,
  account_status   text default 'ACTIVE'::text,
  created_at       timestamptz default now(),
  country_code     varchar(2) default 'NG'::character varying,
  constraint must_have_identity check (wallet_address is not null or email is not null or phone_number is not null)
);

create table if not exists public.deai_identities (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.abapay_global_users(id),
  deai_pin           text not null,
  telegram_chat_id   text unique,
  whatsapp_number    text unique,
  x_twitter_id       text unique,
  pending_auth_token text unique,
  token_expires_at   timestamptz,
  is_active          boolean default true,
  created_at         timestamptz default now()
);
create index if not exists idx_deai_telegram on public.deai_identities (telegram_chat_id);
create index if not exists idx_deai_whatsapp on public.deai_identities (whatsapp_number);
create index if not exists idx_deai_x on public.deai_identities (x_twitter_id);

create table if not exists public.deai_sessions (
  id             uuid primary key default gen_random_uuid(),
  chat_id        text not null unique,
  platform       text default 'TELEGRAM'::text,
  intent_data    jsonb not null,
  selected_token text,
  status         text default 'AWAITING_PIN'::text,
  expires_at     timestamptz not null,
  created_at     timestamptz default now()
);
create index if not exists idx_deai_sessions_chat_id on public.deai_sessions (chat_id);

create table if not exists public.otp_requests (
  phone      text primary key,
  code       text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

-- ── Platform settings (single row; the browser reads it for the rate and kill switches) ─────
create table if not exists public.platform_settings (
  id                       integer primary key,
  exchange_rate            numeric not null,
  kill_switches            jsonb default '{"BANK": true, "CABLE": true, "AIRTIME": true, "INTERNET": true, "EDUCATION": true, "ELECTRICITY": true, "MASTER_INTERNATIONAL": true}'::jsonb,
  x402_facilitator_fee_usd numeric not null default 0.001
);

-- ── Payments ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  wallet_address     text not null,
  service_category   text not null,
  network            text not null,
  account_number     text not null,
  amount_usdt        numeric not null,
  amount_naira       numeric not null,
  fee_naira          numeric not null,
  tx_hash            text not null unique,
  status             text not null,
  contact_details    text,
  created_at         timestamptz not null default timezone('utc'::text, now()),
  request_id         text,
  refund_hash        text,
  purchased_code     text,
  units              text,
  token_used         text default 'USD₮'::text,
  meter_account_type text,
  customer_email     text,
  error_code         text,
  api_response       text,
  blockchain         text default 'CELO'::text,
  service_id         text,
  variation_code     text,
  phone              text,
  operator_id        text,
  country_code       text,
  product_type_id    text,
  subscription_type  text,
  foreign_amount     numeric,
  display_amount     text,
  stamp_duty_ngn     numeric default 0
);

-- ── RLS: on everywhere, as in production ────────────────────────────────────────────────────
-- No policies except platform_settings' public SELECT, which 025 audits and keeps on purpose.
alter table public.abapay_users        enable row level security;
alter table public.wallet_links        enable row level security;
alter table public.abapay_global_users enable row level security;
alter table public.deai_identities     enable row level security;
alter table public.deai_sessions       enable row level security;
alter table public.otp_requests        enable row level security;
alter table public.platform_settings   enable row level security;
alter table public.transactions        enable row level security;

drop policy if exists "Allow public read-only access on settings" on public.platform_settings;
create policy "Allow public read-only access on settings" on public.platform_settings
  for select to public using (true);

-- ── Points RPCs (called with the service-role client) ───────────────────────────────────────
create or replace function public.award_transaction_points(target_wallet text, points_to_add numeric)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
    v_user_id uuid;
    BEGIN
        -- Ensure wallet exists in our tracking table first
            INSERT INTO public.wallet_links (wallet_address, unclaimed_points)
                VALUES (target_wallet, 0)
                    ON CONFLICT (wallet_address) DO NOTHING;

                        -- Safely assign the variable (bypassing the "relation" error)
                            v_user_id := (SELECT user_id FROM public.wallet_links WHERE wallet_address = target_wallet);

                                IF v_user_id IS NOT NULL THEN
                                        -- Add exact volume to the master profile
                                                UPDATE public.abapay_users
                                                        SET total_points = total_points + points_to_add
                                                                WHERE id = v_user_id;
                                                                    ELSE
                                                                            -- Add exact volume to the unverified wallet
                                                                                    UPDATE public.wallet_links
                                                                                            SET unclaimed_points = unclaimed_points + points_to_add
                                                                                                    WHERE wallet_address = target_wallet;
                                                                                                        END IF;
                                                                                                        END;
$function$;

-- NOTE (found while writing this baseline, reproduced as-is): `pending_points` is declared
-- integer but wallet_links.unclaimed_points is numeric(10,2), so linking a wallet truncates its
-- fractional points. Fix it in a numbered migration, not here.
create or replace function public.link_wallet_to_phone(target_wallet text, target_phone text)
returns boolean
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
    master_user_id uuid;
    wallet_count integer;
    pending_points integer;
BEGIN
    -- Check if master profile exists, if not create one
    SELECT id INTO master_user_id FROM public.abapay_users WHERE verified_phone = target_phone;

    IF master_user_id IS NULL THEN
        INSERT INTO public.abapay_users (verified_phone, total_points)
        VALUES (target_phone, 0)
        RETURNING id INTO master_user_id;
    END IF;

    -- SECURITY: Max 3 wallets per phone number
    SELECT COUNT(*) INTO wallet_count FROM public.wallet_links WHERE user_id = master_user_id;
    IF wallet_count >= 3 THEN
        -- Allow if this wallet is ALREADY one of the 3. Reject if it's a new 4th wallet.
        IF NOT EXISTS (SELECT 1 FROM public.wallet_links WHERE wallet_address = target_wallet AND user_id = master_user_id) THEN
            RAISE EXCEPTION 'Security Limit: Maximum of 3 wallets allowed per phone number.';
        END IF;
    END IF;

    -- Ensure wallet exists
    INSERT INTO public.wallet_links (wallet_address, unclaimed_points)
    VALUES (target_wallet, 0)
    ON CONFLICT (wallet_address) DO NOTHING;

    -- Grab any unclaimed points from this specific wallet
    SELECT unclaimed_points INTO pending_points FROM public.wallet_links WHERE wallet_address = target_wallet;

    -- Link wallet to Master Profile and wipe unclaimed points
    UPDATE public.wallet_links
    SET user_id = master_user_id, unclaimed_points = 0, linked_at = now()
    WHERE wallet_address = target_wallet;

    -- Merge the pending points into the Master Profile
    IF pending_points > 0 THEN
        UPDATE public.abapay_users
        SET total_points = total_points + pending_points
        WHERE id = master_user_id;
    END IF;

    RETURN true;
END;
$function$;
