-- link_wallet_to_phone: carry a wallet's unclaimed points over EXACTLY.
--
-- `pending_points` was declared integer while wallet_links.unclaimed_points is numeric(10,2), so
-- linking a wallet to a phone ROUNDED its banked points to a whole number: 1.84 became 2, and
-- 1.4 became 1. Points are earned per ₦1,000 spent, to two decimals, so nearly every balance had
-- a fraction to gain or lose. Found while writing 000_baseline; tests/db/sql.test.ts covers it.
--
-- Only the variable's type changes; the rest of the function is 000's, reindented.
-- Applying to production: run this file in the Supabase SQL editor. It is a CREATE OR REPLACE
-- of an existing function, takes effect immediately, and changes nothing already stored.

create or replace function public.link_wallet_to_phone(target_wallet text, target_phone text)
returns boolean
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
    master_user_id uuid;
    wallet_count integer;
    pending_points numeric(10,2);
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
