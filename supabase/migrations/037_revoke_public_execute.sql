-- Take EXECUTE away from the browser's roles on the three functions that still had it.
--
-- award_transaction_points and link_wallet_to_phone came from the dashboard (see 000_baseline), and
-- enqueue_fulfilment_job (034) is a trigger function; none went through this repo's convention of
-- revoking EXECUTE from public, anon and authenticated. So anyone holding the anon key, which
-- ships in the browser bundle, could call them through /rest/v1/rpc.
--
-- Not exploitable today: they run with the CALLER's rights, and RLS (with no policies) on
-- wallet_links, abapay_users and fulfilment_jobs refuses every write anon could attempt. But
-- that is one policy away from "anyone can mint points or link any wallet to any phone". Only the
-- service-role client (supabaseAdmin) ever calls the points RPCs, and a trigger fires without its
-- function's EXECUTE being checked, so nothing legitimate loses access.

revoke execute on function public.award_transaction_points(text, numeric) from public, anon, authenticated;
revoke execute on function public.link_wallet_to_phone(text, text) from public, anon, authenticated;
revoke execute on function public.enqueue_fulfilment_job() from public, anon, authenticated;

grant execute on function public.award_transaction_points(text, numeric) to service_role;
grant execute on function public.link_wallet_to_phone(text, text) to service_role;
