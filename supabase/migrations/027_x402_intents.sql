-- ============================================================
-- AbaPay — x402 payment intents
-- ============================================================
--
-- 🔴 WHAT THIS SUPPORTS (ABAPAY_FULL_AUDIT.md P-3). /api/pay/x402 used to write its row only
-- AFTER the facilitator had moved the payer's money, and never checked that write. A failed
-- insert — or the function being killed between the facilitator's reply and the insert — left a
-- payment in the vault with no row, no vend and no refund, while the payer was told it was
-- "already being processed".
--
-- The route now records a PENDING intent BEFORE calling the facilitator, keyed by the one thing
-- that identifies an EIP-3009 payment uniquely: (payer, authorization nonce). These columns
-- carry what the reconciler (src/lib/reconcileX402.ts) needs to finish or expire an intent
-- whose request died mid-flight, by asking the token `authorizationState(payer, nonce)`.
--
-- Additive only — no existing column, row or code path changes meaning. Safe to apply before
-- the code that uses it.

alter table public.transactions
  add column if not exists x402_payer        text,
  add column if not exists x402_nonce        text,
  add column if not exists x402_valid_before timestamptz,
  add column if not exists x402_settle_tx    text;

-- One row per signed authorization. The route checks for an existing row first; this makes a
-- race between two submissions of the SAME X-PAYMENT header fail the second insert instead of
-- settling twice. Partial, so every non-x402 row (all NULL here) is unaffected.
create unique index if not exists transactions_x402_authorization_key
  on public.transactions (x402_payer, x402_nonce)
  where x402_nonce is not null;

-- The reconciler's scan: unresolved x402 intents, oldest first.
create index if not exists idx_transactions_x402_open_intents
  on public.transactions (created_at)
  where x402_nonce is not null and status = 'PENDING';
