-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 033_admin_sessions.sql. Roll the application code back first: with the table gone
-- no admin can sign in (and every open session ends).

drop table if exists public.admin_sessions;
