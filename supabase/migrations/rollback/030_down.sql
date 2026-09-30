-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 030_webhook_events.sql. The code tolerates the table being missing (it logs and
-- processes the delivery), so this only turns de-duplication off.

drop table if exists public.webhook_events;
