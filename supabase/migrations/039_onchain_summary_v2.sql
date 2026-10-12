-- onchain_summary() gains what the Dune-style dashboard on /agents/stats needs:
--   * daily volume split by rail (volume_direct / volume_agent / volume_x402), for the stacked
--     daily-volume chart;
--   * by_service: what contract payments bought (AIRTIME, DATA, ...). x402 payments carry no
--     service on-chain, so they are left out of it rather than guessed.
-- Same signature and grants as 038; every field 038 returned is unchanged.

create or replace function public.onchain_summary(p_chain text default null)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with p as (
    select * from onchain_payments where p_chain is null or chain = p_chain
  ),
  firsts as (
    select payer, min(block_time)::date as first_day from p group by payer
  ),
  new_by_day as (
    select first_day as day, count(*) as new_wallets from firsts group by first_day
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'payments', count(*),
        'wallets', count(distinct payer),
        'volume_usd', coalesce(sum(amount_usd), 0),
        'agent_volume_usd', coalesce(sum(amount_usd) filter (where rail in ('agent', 'x402')), 0),
        'first_payment', min(block_time),
        'last_payment', max(block_time)
      ) from p
    ),
    'last30', (
      select jsonb_build_object(
        'payments', count(*),
        'wallets', count(distinct payer),
        'volume_usd', coalesce(sum(amount_usd), 0)
      ) from p where block_time >= now() - interval '30 days'
    ),
    'by_rail', coalesce((
      select jsonb_agg(r order by r.volume_usd desc) from (
        select rail, count(*) as payments, count(distinct payer) as wallets, sum(amount_usd) as volume_usd
        from p group by rail
      ) r
    ), '[]'::jsonb),
    'by_contract', coalesce((
      select jsonb_agg(c order by c.last_payment desc) from (
        select chain, contract, contract_label, count(*) as payments, count(distinct payer) as wallets,
               sum(amount_usd) as volume_usd, min(block_time) as first_payment, max(block_time) as last_payment
        from p group by chain, contract, contract_label
      ) c
    ), '[]'::jsonb),
    'by_service', coalesce((
      select jsonb_agg(v order by v.payments desc) from (
        select service_type, count(*) as payments, sum(amount_usd) as volume_usd
        from p where service_type is not null group by service_type
      ) v
    ), '[]'::jsonb),
    'by_token', coalesce((
      select jsonb_agg(t order by t.volume_usd desc) from (
        select token_symbol, count(*) as payments, sum(amount_usd) as volume_usd
        from p group by token_symbol
      ) t
    ), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(g order by g.payments desc) from (
        select tag, count(*) as payments, max(block_time) as last_payment
        from p, unnest(tags) as tag group by tag
      ) g
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(d order by d.day) from (
        select a.day, a.direct, a.agent, a.x402, a.wallets, a.volume_usd,
               a.volume_direct, a.volume_agent, a.volume_x402, coalesce(nb.new_wallets, 0) as new_wallets
        from (
          select block_time::date as day,
                 count(*) filter (where rail = 'direct') as direct,
                 count(*) filter (where rail = 'agent')  as agent,
                 count(*) filter (where rail = 'x402')   as x402,
                 count(distinct payer)                   as wallets,
                 sum(amount_usd)                         as volume_usd,
                 coalesce(sum(amount_usd) filter (where rail = 'direct'), 0) as volume_direct,
                 coalesce(sum(amount_usd) filter (where rail = 'agent'), 0)  as volume_agent,
                 coalesce(sum(amount_usd) filter (where rail = 'x402'), 0)   as volume_x402
          from p group by block_time::date
        ) a
        left join new_by_day nb on nb.day = a.day
      ) d
    ), '[]'::jsonb),
    'cursors', coalesce((
      select jsonb_agg(jsonb_build_object('chain', chain, 'last_block', last_block, 'head_block', head_block, 'updated_at', updated_at))
      from onchain_cursors where p_chain is null or chain = p_chain
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.onchain_summary(text) from public, anon, authenticated;
grant execute on function public.onchain_summary(text) to service_role;
