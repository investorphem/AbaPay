-- onchain_windows(), same output as 041, built without the per-day rescans.
--
-- 041 computed the active-wallet series (dau, wau, mau) with three correlated subqueries per day,
-- each re-reading every payment: about 2.8 GB of temporary reads for the Celo page and 5.8 s for the
-- overview with the database idle. Busy, it passed the API's 8 s statement timeout, the call failed,
-- and stats.abapays.com fell back to all-time numbers ("range totals unavailable") even with 7D or
-- 30D selected.
--
-- Now each (day, wallet) pair is reduced once, and the series is one join of each day against the
-- 30 days ending on it. The windows read the payments once as well. The JSON is identical to 041's.

create or replace function public.onchain_windows(p_chain text default null)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with p as materialized (
    select tx_hash, payer, amount_usd, rail, token_symbol, chain, tags, block_time,
           (block_time at time zone 'Africa/Lagos')::date as lday
    from onchain_payments where p_chain is null or chain = p_chain
  ),
  firsts as (
    select payer, min(block_time) as first_time from p group by payer
  ),
  w(key, since) as (
    values ('7', now() - interval '7 days'),
           ('30', now() - interval '30 days'),
           ('90', now() - interval '90 days'),
           ('all', '-infinity'::timestamptz)
  ),
  pw as materialized (
    select w.key, p.* from w join p on p.block_time >= w.since
  ),
  totals as (
    select w.key,
           count(p.tx_hash) as payments,
           count(distinct p.payer) as wallets,
           coalesce(sum(p.amount_usd), 0) as volume_usd,
           coalesce(sum(p.amount_usd) filter (where p.rail in ('agent', 'x402')), 0) as agent_volume_usd,
           (select count(*) from firsts f where f.first_time >= w.since) as new_wallets
    from w left join p on p.block_time >= w.since
    group by w.key, w.since
  ),
  day_payers as (
    select distinct lday, payer from p
  ),
  days as (
    select generate_series((select min(lday) from p), (now() at time zone 'Africa/Lagos')::date, interval '1 day')::date as d
  ),
  active as (
    select days.d as day,
           count(distinct dp.payer) filter (where dp.lday = days.d) as dau,
           count(distinct dp.payer) filter (where dp.lday >= days.d - 6) as wau,
           count(distinct dp.payer) as mau
    from days left join day_payers dp on dp.lday between days.d - 29 and days.d
    group by days.d
  )
  select jsonb_build_object(
    'windows', (
      select jsonb_object_agg(t.key, jsonb_build_object(
        'payments', t.payments,
        'wallets', t.wallets,
        'new_wallets', t.new_wallets,
        'volume_usd', t.volume_usd,
        'agent_volume_usd', t.agent_volume_usd,
        'by_rail', coalesce((
          select jsonb_agg(r order by r.volume_usd desc) from (
            select rail, count(*) as payments, count(distinct payer) as wallets, sum(amount_usd) as volume_usd
            from pw where pw.key = t.key group by rail
          ) r
        ), '[]'::jsonb),
        'by_token', coalesce((
          select jsonb_agg(k order by k.volume_usd desc) from (
            select token_symbol, count(*) as payments, sum(amount_usd) as volume_usd
            from pw where pw.key = t.key group by token_symbol
          ) k
        ), '[]'::jsonb),
        'by_chain', coalesce((
          select jsonb_agg(c order by c.volume_usd desc) from (
            select chain, count(*) as payments, sum(amount_usd) as volume_usd
            from pw where pw.key = t.key group by chain
          ) c
        ), '[]'::jsonb),
        'tags', coalesce((
          select jsonb_agg(g order by g.payments desc) from (
            select tag, count(*) as payments, max(block_time) as last_payment
            from pw, unnest(pw.tags) as tag where pw.key = t.key group by tag
          ) g
        ), '[]'::jsonb)
      ))
      from totals t
    ),
    'active', coalesce((
      select jsonb_agg(a order by a.day) from (select day, dau, wau, mau from active) a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.onchain_windows(text) from public, anon, authenticated;
grant execute on function public.onchain_windows(text) to service_role;
