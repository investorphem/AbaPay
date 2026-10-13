-- onchain_windows(): the numbers on stats.abapays.com that follow the page's range switch (7D, 30D,
-- 90D, All), plus the active-wallet series (DAU, WAU, MAU). onchain_summary() stays as it is: the
-- agents home page reads it.
--
-- Windows are rolling (now() minus 7, 30 or 90 days), like onchain_summary()'s last30. Each one has
-- the counters, the rail, token and chain splits and the attribution tags for the payments in it,
-- so every panel on the page can show the chosen range, not only the charts.
--
-- active: one row per Nigerian (WAT, Africa/Lagos) day from the first payment to today, with the
-- distinct paying wallets on that day (dau), in the 7 days ending that day (wau) and in the 30 days
-- ending that day (mau). The last row is today.

create or replace function public.onchain_windows(p_chain text default null)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with p as (
    select *, (block_time at time zone 'Africa/Lagos')::date as lday
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
  pw as (
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
  days as (
    select generate_series((select min(lday) from p), (now() at time zone 'Africa/Lagos')::date, interval '1 day')::date as d
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
      select jsonb_agg(a order by a.day) from (
        select days.d as day,
               (select count(distinct payer) from p where p.lday = days.d) as dau,
               (select count(distinct payer) from p where p.lday between days.d - 6 and days.d) as wau,
               (select count(distinct payer) from p where p.lday between days.d - 29 and days.d) as mau
        from days
      ) a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.onchain_windows(text) from public, anon, authenticated;
grant execute on function public.onchain_windows(text) to service_role;
