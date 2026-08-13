-- ============================================================
-- AbaPay — pin search_path on existing functions
-- ============================================================
--
-- Supabase's database linter flags both of these as `function_search_path_mutable`.
--
-- Neither is SECURITY DEFINER (verified: pg_proc.prosecdef = false for both), so the usual
-- privilege-escalation route does not apply here — they execute with the caller's rights, and
-- the only caller is the backend service role. This is therefore hardening, not an active
-- vulnerability.
--
-- It still matters: with a mutable search_path, an unqualified object reference inside the
-- function body resolves against whatever search_path the SESSION happens to carry. Pinning it
-- to `public, pg_temp` means these functions always resolve to the objects they were written
-- against, and closes the lint.
--
-- ALTER FUNCTION ... SET is metadata-only — it does not rewrite or re-plan the body, so this is
-- safe to run against a live database.

alter function public.award_transaction_points(target_wallet text, points_to_add numeric)
  set search_path = public, pg_temp;

alter function public.link_wallet_to_phone(target_wallet text, target_phone text)
  set search_path = public, pg_temp;
