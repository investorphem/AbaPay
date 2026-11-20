-- Agent controls, separate from AbaPay's own chat agent and from web/MiniPay customers.
--
-- "Outside agents" are callers of the x402, MCP and A2A endpoints. "Verified agents" are outside
-- agents whose request carries a Self Agent ID signature the SelfAgentRegistry confirms
-- (src/lib/selfAgent.ts): registered, human-backed by Self's own provider, proof still fresh.
-- Every switch starts off and every cap starts empty, so nothing changes until the operator sets
-- it in Admin → Agent → Outside agents.
--
--   agent_ext_max_ngn_per_tx / agent_ext_daily_cap_ngn   caps for outside agents (null = none)
--   verified_agent_discounts_enabled                       discount campaigns apply to verified agents
--   verified_agent_fee_waiver_enabled                      verified agents pay no x402 facilitator fee
--   verified_agent_higher_limits_enabled                   verified agents use the caps below instead
--   verified_agent_max_ngn_per_tx / verified_agent_daily_cap_ngn   (null = no cap)
--   verified_agent_bank_enabled                            verified agents may pay bank transfers
--
-- The agent_max_ngn_per_tx / agent_daily_cap_ngn columns (migration 006) stay what they are: the
-- chat agent's settings.
alter table public.platform_settings
  add column if not exists agent_ext_max_ngn_per_tx numeric check (agent_ext_max_ngn_per_tx > 0),
  add column if not exists agent_ext_daily_cap_ngn numeric check (agent_ext_daily_cap_ngn > 0),
  add column if not exists verified_agent_discounts_enabled boolean not null default false,
  add column if not exists verified_agent_fee_waiver_enabled boolean not null default false,
  add column if not exists verified_agent_higher_limits_enabled boolean not null default false,
  add column if not exists verified_agent_max_ngn_per_tx numeric check (verified_agent_max_ngn_per_tx > 0),
  add column if not exists verified_agent_daily_cap_ngn numeric check (verified_agent_daily_cap_ngn > 0),
  add column if not exists verified_agent_bank_enabled boolean not null default false;

-- The verified Self Agent ID a payment was made under, for the ledger, the caps and the receipts.
alter table public.transactions
  add column if not exists self_agent_id text,
  add column if not exists self_agent_address text;

-- Bank transfers paid by verified agents. One row per paid order; the order itself sits in
-- transactions with status AWAITING_PAYOUT until the transfer is recorded as sent. The proof is
-- the transfer receipt, kept here (small images only) and served only to the agent
-- that paid, after it proves its Self Agent ID again.
create table if not exists public.bank_payouts (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete restrict,
  tx_hash text not null,
  wallet text not null,
  self_agent_id text not null,
  self_agent_address text not null,
  bank_code text not null,
  bank_name text,
  account_number text not null,
  account_name text,
  amount_ngn numeric not null check (amount_ngn > 0),
  narration text,
  status text not null default 'AWAITING' check (status in ('AWAITING', 'PAID', 'REFUNDED')),
  payout_reference text,
  proof_image bytea,
  proof_mime text check (proof_mime is null or proof_mime in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')),
  operator_note text,
  paid_at timestamptz,
  paid_by text,
  created_at timestamptz not null default now(),
  check (proof_image is null or octet_length(proof_image) <= 2 * 1024 * 1024),
  check (status <> 'PAID' or (payout_reference is not null and paid_at is not null))
);

create index if not exists bank_payouts_status_idx on public.bank_payouts (status, created_at);

alter table public.bank_payouts enable row level security;
revoke all on table public.bank_payouts from public, anon, authenticated;
grant all on table public.bank_payouts to service_role;
