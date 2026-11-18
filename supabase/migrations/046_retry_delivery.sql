-- ⚡ RETRY A FAILED DELIVERY (admin → Ops → Refunds → Retry delivery, src/lib/retryDelivery.ts)
--
-- The state guard (026) allows the vend lock only from PENDING (R5) and freezes request_id once a
-- row leaves PENDING (R2). Both are right for every automatic path. An operator retrying a failed
-- VTpass order (FAILED_VENDING, payment proven on chain, VTpass confirmed the old request was not
-- delivered) needs exactly one exception: FAILED_VENDING → PROCESSING under a NEW request_id.
--
-- The exception is only reachable through claim_failed_vend_for_retry(), which sets a
-- transaction-local flag the guard checks. The function is service_role only, so no client key
-- can use it, and it only touches an unrefunded FAILED_VENDING row.

create or replace function public.transactions_state_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  retrying boolean := coalesce(current_setting('abapay.retry_delivery', true), '') = 'on'
    and old.status = 'FAILED_VENDING' and new.status = 'PROCESSING';
begin
  -- R1: only a preflight placeholder may be renamed to a real hash.
  if new.tx_hash is distinct from old.tx_hash
     and coalesce(old.tx_hash, '') not like 'preflight\_%' escape '\' then
    raise exception 'AbaPay state guard: tx_hash of a non-preflight row is immutable (row %)', old.id
      using errcode = 'P0001';
  end if;

  -- R2: request_id is fixed once the row has left PENDING (except an admin retry: a new request).
  if new.request_id is distinct from old.request_id and old.status is distinct from 'PENDING' and not retrying then
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

  -- R5: the vend lock is only ever taken from PENDING (or FAILED_VENDING by an admin retry).
  if new.status = 'PROCESSING' and old.status is distinct from 'PENDING' and not retrying then
    raise exception 'AbaPay state guard: only PENDING may move to PROCESSING, not % (row %)', old.status, old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Claims one failed order for a single new delivery. Returns the claimed row, or nothing when the
-- row isn't (any longer) an unrefunded FAILED_VENDING order, so exactly one caller wins.
create or replace function public.claim_failed_vend_for_retry(p_id uuid, p_request_id text)
returns setof public.transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_request_id is null or length(p_request_id) < 12 then
    raise exception 'claim_failed_vend_for_retry: a new request_id is required';
  end if;
  perform set_config('abapay.retry_delivery', 'on', true);
  return query
    update public.transactions
       set status = 'PROCESSING', request_id = p_request_id, vend_dispatched_at = null,
           error_code = null, api_response = null
     where id = p_id and status = 'FAILED_VENDING' and refund_hash is null
       and request_id is distinct from p_request_id
    returning *;
  perform set_config('abapay.retry_delivery', 'off', true);
end;
$$;

revoke all on function public.claim_failed_vend_for_retry(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_failed_vend_for_retry(uuid, text) to service_role;
