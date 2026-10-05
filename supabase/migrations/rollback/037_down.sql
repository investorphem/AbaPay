-- Rollback for 037_revoke_public_execute.sql: gives EXECUTE back to the browser roles.
-- Only if a legitimate anon/authenticated caller turns up; none exists in the app.

grant execute on function public.award_transaction_points(text, numeric) to public, anon, authenticated;
grant execute on function public.link_wallet_to_phone(text, text) to public, anon, authenticated;
grant execute on function public.enqueue_fulfilment_job() to public, anon, authenticated;
