-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 028_provider_circuits.sql. Roll the application code back first: it reads
-- provider_circuits and calls set_provider_circuit. Dropping the column also drops any breaker
-- that is currently OPEN — sales for that provider resume immediately.

drop function if exists public.set_provider_circuit(text, boolean, text);
alter table public.platform_settings drop column if exists provider_circuits;
