-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 032_auth_nonces.sql. Roll the application code back first: with these gone every
-- SIWE proof fails (its nonce can't be checked), leaving only the legacy format, and only
-- until LEGACY_WALLET_SIG_ACCEPT_UNTIL.

drop function if exists public.consume_auth_nonce(text, text);
drop table if exists public.auth_nonces;
