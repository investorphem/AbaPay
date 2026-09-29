-- ============================================================
-- AbaPay — transaction state guard (emergency containment)
-- ============================================================
--
-- 🔴 WHAT THIS STOPS. /api/pay's `intent_only` branch writes its row with
-- `upsert(..., { onConflict: 'tx_hash' })` using a tx_hash the CALLER supplies. tx_hash is
-- UNIQUE, so pointing that call at an existing row UPDATES it: status back to PENDING and a
-- fresh request_id. A second /api/pay call with the same (real, still-valid) on-chain hash then
-- re-verifies the receipt, wins the PENDING -> PROCESSING lock and vends again — one payment,
-- many deliveries, and a REFUNDED payment turned into a free vend. See ABAPAY_FULL_AUDIT.md
-- P-1 / S-1 / B-1.
--
-- This trigger closes that at the one layer every writer shares, without a code deploy. The
-- application fix (server-issued intent ids, insert-only writes, a unique payment-proof table)
-- follows in ABAPAY_IMPLEMENTATION_PLAN.md M1.2 / M1.4; this guard stays after it lands.
--
-- ⚠️ DELIBERATELY PERMISSIVE. Every transition the current code legitimately performs still
-- works — the guard only refuses the specific moves a replay needs. Rules:
--
--   R1  tx_hash may change only while it is still a `preflight_…` placeholder. Every rename in
--       the codebase (frontend settle, webhook rescue, relayer, scheduler) renames a preflight.
--   R2  request_id may change only while the row is PENDING. The only legitimate writers set it
--       on the PENDING -> PROCESSING lock (/api/pay, /api/pay/x402). A replay ALWAYS writes a
--       fresh one, so this is what protects a row sitting in PROCESSING (e.g. a stuck bank
--       transfer) from being replayed into a second payout.
--   R3  REFUNDED, EXPIRED and FAILED_PAYMENT are terminal: status can no longer change.
--   R4  A row may become PENDING only from PENDING or PROCESSING. PROCESSING -> PENDING is
--       still used by vend.ts / monnifyVend.ts / the Alchemy webhook on a provider or RPC
--       hiccup (request_id unchanged); it is removed in plan item M2.1.
--   R5  A row may become PROCESSING only from PENDING — that transition IS the vend lock.
--
-- Everything else (e.g. SUCCESS -> REVERSED_NEEDS_REFUND, FAILED_VENDING -> REFUNDED, and
-- column updates that leave status alone) is allowed unchanged. Tightening beyond this is plan
-- item M1.4 / M2.3, once the code no longer depends on the permissive cases.
--
-- A refused write raises SQLSTATE P0001 with a message starting `AbaPay state guard:`. For the
-- /api/pay attack that surfaces as the existing "PREFLIGHT WRITE FAILED" Telegram alert and a
-- 500 to the caller — which also makes every blocked attempt visible to the operator.
--
-- Rollback: supabase/migrations/rollback/026_down.sql — which re-opens B-1. Prefer adding a
-- missing legitimate transition here over dropping the guard.

create or replace function public.transactions_state_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- R1: only a preflight placeholder may be renamed to a real hash.
  if new.tx_hash is distinct from old.tx_hash
     and coalesce(old.tx_hash, '') not like 'preflight\_%' escape '\' then
    raise exception 'AbaPay state guard: tx_hash of a non-preflight row is immutable (row %)', old.id
      using errcode = 'P0001';
  end if;

  -- R2: request_id is fixed once the row has left PENDING.
  if new.request_id is distinct from old.request_id and old.status is distinct from 'PENDING' then
    raise exception 'AbaPay state guard: request_id cannot change once a row is % (row %)', old.status, old.id
      using errcode = 'P0001';
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  -- R3: terminal states stay terminal.
  if old.status in ('REFUNDED', 'EXPIRED', 'FAILED_PAYMENT') then
    raise exception 'AbaPay state guard: % is terminal, cannot move to % (row %)', old.status, new.status, old.id
      using errcode = 'P0001';
  end if;

  -- R4: nothing finished can be sent back to PENDING.
  if new.status = 'PENDING' and old.status not in ('PENDING', 'PROCESSING') then
    raise exception 'AbaPay state guard: % cannot move back to PENDING (row %)', old.status, old.id
      using errcode = 'P0001';
  end if;

  -- R5: the vend lock is only ever taken from PENDING.
  if new.status = 'PROCESSING' and old.status is distinct from 'PENDING' then
    raise exception 'AbaPay state guard: only PENDING may move to PROCESSING, not % (row %)', old.status, old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Trigger functions are never called directly; keep them out of reach of the API roles anyway.
revoke all on function public.transactions_state_guard() from public, anon, authenticated;

drop trigger if exists transactions_state_guard on public.transactions;
create trigger transactions_state_guard
  before update on public.transactions
  for each row
  execute function public.transactions_state_guard();
