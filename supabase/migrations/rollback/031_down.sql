-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 031_idempotency.sql. Roll the application code back FIRST: with the table gone,
-- runIdempotent cannot claim a key and refuses every pay_bill / pay_bill_batch /
-- schedule_bill call (by design — it will not move money without retry protection).

drop table if exists public.idempotency_keys;
