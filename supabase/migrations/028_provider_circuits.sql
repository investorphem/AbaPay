-- ============================================================
-- AbaPay — provider circuit breakers
-- ============================================================
--
-- 🔴 WHAT THIS SUPPORTS. When the VTpass float runs dry, every vend fails with 018 ("LOW WALLET
-- BALANCE") — AFTER the payer's crypto has landed in the vault. The app alerted, but kept
-- selling: every later payer was charged on-chain and then refunded, which is how 393 payments
-- ended FAILED_VENDING/REFUNDED on code 018 alone. A breaker trips on the first 018 (or
-- Monnify's D04) and refuses that provider's services BEFORE anything is paid, until the float
-- is back — see src/lib/circuitBreaker.ts.
--
-- 🔴 WHY A SEPARATE COLUMN, NOT A KEY IN kill_switches. The admin dashboard saves kill switches
-- by writing back its ENTIRE local copy of that map (/api/admin/action UPDATE_KILL_SWITCHES).
-- A breaker key written by the server in between would be silently erased — or resurrected — by
-- the next toggle from a page loaded earlier. Operator switches and automatic breakers are
-- different owners; they get different storage.
--
-- Shape: { "VTPASS": { "open": true, "since": "<ts>", "reason": "..." }, "MONNIFY": { ... } }
-- Readable through platform_settings' existing public SELECT policy (it holds no secrets — the
-- same reasoning migration 025 recorded for kill_switches); writable only via the function.

alter table public.platform_settings
  add column if not exists provider_circuits jsonb not null default '{}'::jsonb;

-- Atomic open/close. Returns TRUE only when the state actually changed, so the caller alerts
-- once per transition instead of once per failed vend. An already-open breaker keeps its
-- original `since`.
create or replace function public.set_provider_circuit(p_provider text, p_open boolean, p_reason text)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  was_open boolean;
begin
  select coalesce((provider_circuits -> p_provider ->> 'open')::boolean, false)
    into was_open
    from public.platform_settings
   where id = 1
     for update;

  if was_open is not distinct from p_open then
    return false;
  end if;

  update public.platform_settings
     set provider_circuits = coalesce(provider_circuits, '{}'::jsonb)
       || jsonb_build_object(p_provider, jsonb_build_object('open', p_open, 'since', now(), 'reason', left(p_reason, 200)))
   where id = 1;

  return true;
end;
$$;

revoke all on function public.set_provider_circuit(text, boolean, text) from public, anon, authenticated;
