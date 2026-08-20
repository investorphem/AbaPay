-- 🔴 CRITICAL SECURITY FIX. `transactions` had RLS ENABLED and four policies that gave it all
-- away again. Enabling RLS and then writing `USING (true)` is not protection; it is protection
-- switched off in a way that reads as switched on, which is why this survived a table-by-table
-- RLS audit (see 022, which counted this table among the protected ones).
--
-- What was actually granted, all of it to `anon` — the key that ships in the browser bundle by
-- design, readable by anyone who opens devtools:
--
--   Allow public read-only access on transactions   SELECT to public  USING (true)
--   Allow admin to read transactions                SELECT to anon    USING (true)
--   Allow app to insert transactions                INSERT to anon    WITH CHECK (true)
--   Allow app to update transactions                UPDATE to anon    USING (true)
--
-- So: every payment AbaPay has ever processed was world-readable — phone numbers, meter and
-- smartcard numbers, customer names and addresses, amounts, wallet addresses, the lot — and
-- worse than readable. INSERT let anyone forge transaction rows; UPDATE let anyone rewrite
-- existing ones, including `status` and `refund_hash`, which is the reconciliation pipeline's
-- own source of truth about what has been paid and what is still owed.
--
-- The policy NAMES are the tell. "Allow app to insert" and "Allow admin to read" describe jobs
-- that are not done with the anon key at all: every server path in this codebase uses the
-- service-role client (`supabaseAdmin`), which bypasses RLS entirely and never needed a policy.
-- They read like scaffolding from before the service-role client existed, left behind.
--
-- ⚠️ NO REPLACEMENT POLICIES, DELIBERATELY — same reasoning as 022. RLS enabled with zero
-- policies denies anon and authenticated everything, which is exactly right here. Do not "fix"
-- the resulting `rls_enabled_no_policy` advisory by adding one; that advisory is INFO and
-- describes the intended end state, and any permissive policy re-opens precisely this hole.
--
-- ⛔ ORDER OF OPERATIONS — THIS BREAKS THE APP IF RUN TOO EARLY.
--
-- The browser genuinely did read this table with the anon key: the History tab. That read has
-- been replaced by GET /api/history, which derives the wallet address from a SIGNATURE and
-- queries with the service-role client. Run this migration only ONCE THAT CODE IS DEPLOYED, or
-- History goes blank for everyone until it is. Nothing else in the app touches `transactions`
-- with the anon key — verified by import: every other caller imports `supabaseAdmin`.
--
-- Rolling back re-opens the exposure. If History breaks, fix the deploy, not this file.

drop policy if exists "Allow public read-only access on transactions" on public.transactions;
drop policy if exists "Allow admin to read transactions"              on public.transactions;
drop policy if exists "Allow app to insert transactions"              on public.transactions;
drop policy if exists "Allow app to update transactions"              on public.transactions;

-- Already enabled; asserted here so the table's protection does not depend on history.
alter table public.transactions enable row level security;
