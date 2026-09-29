-- ============================================================
-- AbaPay — atomic PIN attempt accounting
-- ============================================================
--
-- 🔴 THE RACE THIS CLOSES. src/lib/deai/pinSecurity.ts used to read failed_pin_attempts, add
-- one in JavaScript and write it back — and only AFTER the PIN had been checked. Twenty wrong
-- PINs sent in parallel all passed the lockout check (the counter was still 0 for every one of
-- them), all ran scrypt, and all wrote back "1". So the 5-attempt lockout bounded sequential
-- guessing only; a parallel burst got as many guesses as it could send.
--
-- The fix is to spend the attempt BEFORE the PIN is evaluated, under a row lock: an attempt
-- is reserved (counter + 1) or refused in one statement per identity, so at most MAX attempts
-- ever reach scrypt between lockouts, however many arrive at once. A correct PIN then clears
-- the counter (pin_attempt_clear), exactly as before.
--
-- Ladder (unchanged): the 5th, 10th, 15th… reserved attempt locks the identity for
-- 1m, 5m, 30m, 2h, then 24h for every further lockout. The lock is set when the attempt is
-- RESERVED, so it applies to everything in flight behind it; if that attempt turns out to be
-- the correct PIN, the clear lifts it again.

create or replace function public.pin_attempt_reserve(p_link_id uuid)
returns table (allowed boolean, attempts integer, locked_until timestamptz, locked_now boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  max_attempts constant integer := 5;
  ladder constant integer[] := array[1, 5, 30, 120, 1440];
  cur_attempts integer;
  cur_until timestamptz;
  next_attempts integer;
  new_until timestamptz;
begin
  select l.failed_pin_attempts, l.locked_until
    into cur_attempts, cur_until
    from public.agent_links l
   where l.id = p_link_id
     for update;

  if not found then
    -- No such identity: nothing to count against. Callers only reach this with a link id they
    -- just resolved, so refuse rather than hand out an uncounted attempt.
    return query select false, 0, null::timestamptz, false;
    return;
  end if;

  if cur_until is not null and cur_until > now() then
    return query select false, cur_attempts, cur_until, false;
    return;
  end if;

  next_attempts := coalesce(cur_attempts, 0) + 1;
  new_until := null;
  if next_attempts % max_attempts = 0 then
    new_until := now() + make_interval(mins => ladder[least(next_attempts / max_attempts, array_length(ladder, 1))]);
  end if;

  update public.agent_links
     set failed_pin_attempts = next_attempts,
         locked_until = new_until
   where id = p_link_id;

  return query select true, next_attempts, new_until, new_until is not null;
end;
$$;

create or replace function public.pin_attempt_clear(p_link_id uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.agent_links set failed_pin_attempts = 0, locked_until = null where id = p_link_id;
$$;

revoke all on function public.pin_attempt_reserve(uuid) from public, anon, authenticated;
revoke all on function public.pin_attempt_clear(uuid) from public, anon, authenticated;
