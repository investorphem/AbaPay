-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 029_pin_attempts.sql. Roll the application code back first: pinSecurity.ts calls
-- both functions, and with them gone every PIN check fails closed (refused), by design.
-- The failed_pin_attempts / locked_until columns belong to 004 and are left in place.

drop function if exists public.pin_attempt_reserve(uuid);
drop function if exists public.pin_attempt_clear(uuid);
