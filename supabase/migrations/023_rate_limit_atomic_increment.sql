-- ============================================================
-- AbaPay — atomic rate-limit counter
-- ============================================================
--
-- Backs src/lib/rateLimit.ts.
--
-- 🔴 THE BUG THIS FIXES: rateLimit() used to do a SELECT, decide in JavaScript whether the
-- caller was under the limit, then issue a separate UPDATE. Between the read and the write,
-- every other concurrent request read the SAME count and every one of them decided it was
-- under the limit. Under exactly the traffic a throttle exists to stop — a burst — the limit
-- was therefore not enforced at all: N concurrent requests all saw `count = k` and all wrote
-- `k + 1`, so the counter advanced by one instead of N and far more than `limit` requests got
-- through.
--
-- This does the whole check-and-increment in ONE statement, inside Postgres, where the row
-- lock makes it atomic. The window roll and the increment happen together, and the caller gets
-- back the post-increment count to compare against its limit.
--
-- Returns the number of requests used in the CURRENT window (>= 1), and that window's start.

create or replace function public.rate_limit_hit(
  p_key            text,
  p_window_seconds integer
)
returns table (used integer, window_start timestamptz)
language plpgsql
-- Pinned search_path: this function is called with the service role, and an unqualified
-- reference must never be resolvable to an attacker-shadowed object in another schema.
set search_path = public, pg_temp
as $$
begin
  return query
  insert into public.rate_limits as rl (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set
      -- Window elapsed -> start a fresh one at 1. Otherwise increment in place.
      count = case
                when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1
                else rl.count + 1
              end,
      window_start = case
                when rl.window_start < now() - make_interval(secs => p_window_seconds) then now()
                else rl.window_start
              end
  returning rl.count, rl.window_start;
end;
$$;

-- Only ever invoked by the backend with the service-role key (which bypasses RLS). Revoke the
-- public/anon grants so a leaked anon key cannot manipulate throttle counters.
revoke all on function public.rate_limit_hit(text, integer) from public, anon, authenticated;
