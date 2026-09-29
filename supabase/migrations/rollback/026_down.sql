-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Removes the transaction state guard from 026_transaction_state_guard.sql. Doing so RE-OPENS
-- the /api/pay replay / double-vend (ABAPAY_FULL_AUDIT.md P-1) unless the application fix
-- (ABAPAY_IMPLEMENTATION_PLAN.md M1.2 + M1.4) is already deployed.
--
-- If a legitimate flow is being blocked, prefer adding that transition to the guard function
-- instead of running this.

drop trigger if exists transactions_state_guard on public.transactions;
drop function if exists public.transactions_state_guard();
