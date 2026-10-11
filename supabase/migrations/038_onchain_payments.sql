-- AbaPay's own on-chain index: every payment into an AbaPay vault, read straight from the chain.
--
-- Replaces Dune as the source of the public numbers (the Dune account's plan stopped refreshing
-- them on 2026-09-23). src/lib/onchain/indexer.ts fills it from each chain's RPC, and
-- /agents/stats and the agents home page read it through onchain_summary().
--
-- Same definitions as dune/celo-chain/00_events.sql, so the numbers mean what they meant on Dune:
--   * a contract payment (payBill / payBillFor) is one PaymentReceived event;
--   * it is the AGENT rail when the same transaction also emitted AgentPayment (the relayer spent
--     a user's allowance), otherwise DIRECT;
--   * any other stablecoin transfer into a vault is X402 (a facilitator settled an EIP-3009
--     authorisation; it never calls payBill, so it emits no PaymentReceived).
-- No amount floor: this reports what the chain recorded. Whether a bill was delivered, refunded
-- or failed is the transactions table's question, not this one's.
--
-- `account_number` from PaymentReceived (a meter / phone number) is customer PII and is never
-- stored here. Payer addresses are already public on-chain.

create table if not exists public.onchain_payments (
  chain          text        not null check (chain in ('CELO', 'BASE')),
  tx_hash        text        not null,
  log_index      integer     not null,
  block_number   bigint      not null,
  block_time     timestamptz not null,
  contract       text        not null,
  contract_label text        not null,
  payer          text        not null,
  token_address  text        not null,
  token_symbol   text        not null,
  amount_usd     numeric(30, 6) not null,
  rail           text        not null check (rail in ('direct', 'agent', 'x402')),
  service_type   text,
  -- ERC-8021 attribution codes found in the transaction's calldata. Always empty for x402: the
  -- facilitator submits those transactions, not AbaPay.
  tags           text[]      not null default '{}',
  primary key (chain, tx_hash, log_index)
);

create index if not exists onchain_payments_chain_time on public.onchain_payments (chain, block_time desc);
create index if not exists onchain_payments_chain_payer on public.onchain_payments (chain, payer);

-- How far each chain has been indexed. The indexer resumes from last_block + 1.
create table if not exists public.onchain_cursors (
  chain      text        primary key check (chain in ('CELO', 'BASE')),
  last_block bigint      not null,
  head_block bigint,
  updated_at timestamptz not null default now()
);

alter table public.onchain_payments enable row level security;
alter table public.onchain_cursors enable row level security;
revoke all on public.onchain_payments from anon, authenticated;
revoke all on public.onchain_cursors from anon, authenticated;

-- Everything the stats pages show, in one round trip. p_chain null = both chains.
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
        select a.day, a.direct, a.agent, a.x402, a.wallets, a.volume_usd, coalesce(nb.new_wallets, 0) as new_wallets
        from (
          select block_time::date as day,
                 count(*) filter (where rail = 'direct') as direct,
                 count(*) filter (where rail = 'agent')  as agent,
                 count(*) filter (where rail = 'x402')   as x402,
                 count(distinct payer)                   as wallets,
                 sum(amount_usd)                         as volume_usd
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
