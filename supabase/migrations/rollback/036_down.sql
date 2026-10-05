-- Rollback for 036_link_wallet_points_precision.sql: restores the integer `pending_points`
-- (which ROUNDS points when a wallet is linked). Only if 036 itself causes a problem.

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
    SELECT id INTO master_user_id FROM public.abapay_users WHERE verified_phone = target_phone;
    IF master_user_id IS NULL THEN
        INSERT INTO public.abapay_users (verified_phone, total_points)
        VALUES (target_phone, 0)
        RETURNING id INTO master_user_id;
    END IF;
    SELECT COUNT(*) INTO wallet_count FROM public.wallet_links WHERE user_id = master_user_id;
    IF wallet_count >= 3 THEN
        IF NOT EXISTS (SELECT 1 FROM public.wallet_links WHERE wallet_address = target_wallet AND user_id = master_user_id) THEN
            RAISE EXCEPTION 'Security Limit: Maximum of 3 wallets allowed per phone number.';
        END IF;
    END IF;
    INSERT INTO public.wallet_links (wallet_address, unclaimed_points)
    VALUES (target_wallet, 0)
    ON CONFLICT (wallet_address) DO NOTHING;
    SELECT unclaimed_points INTO pending_points FROM public.wallet_links WHERE wallet_address = target_wallet;
    UPDATE public.wallet_links
    SET user_id = master_user_id, unclaimed_points = 0, linked_at = now()
    WHERE wallet_address = target_wallet;
    IF pending_points > 0 THEN
        UPDATE public.abapay_users
        SET total_points = total_points + pending_points
        WHERE id = master_user_id;
    END IF;
    RETURN true;
END;
$function$;
