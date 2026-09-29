-- ⚠️ EMERGENCY USE ONLY — NEVER AUTO-APPLIED.
--
-- Reverses 027_x402_intents.sql. Roll the /api/pay/x402 code back FIRST: the intent-before-
-- settle path writes these columns. Before dropping them, resolve every open x402 intent
-- (tx_hash LIKE 'preflight_x402_%' AND status = 'PENDING') — once the columns are gone the
-- reconciler can no longer tell which authorization a row belongs to.

drop index if exists public.idx_transactions_x402_open_intents;
drop index if exists public.transactions_x402_authorization_key;

alter table public.transactions
  drop column if exists x402_settle_tx,
  drop column if exists x402_valid_before,
  drop column if exists x402_nonce,
  drop column if exists x402_payer;
