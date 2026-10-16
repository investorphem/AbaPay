-- Who is paying: agent identity for the admin dashboard (src/lib/payerIdentity.ts).
--
-- payer_identities: one row per paying wallet, cached for a day. What the chain says about the
-- wallet: the ERC-8004 agent identities it owns or is the declared wallet of (with each agent's
-- registered name, description and endpoints), and whether it is a Self Agent ID (a
-- proof-of-human agent registration, github.com/selfxyz) and if that proof is still fresh.
--
-- payment_client_info: what the request itself said about its client, per payment — User-Agent
-- and any agent name / ERC-8004 id it declared in headers. Claims, not proof; the dashboard
-- shows them next to the on-chain facts.
--
-- Kept OUT of `transactions` on purpose: rows of that table are read whole by public surfaces
-- (receipts, history). Service-role only: RLS on, no policies. Only /api/admin/data reads them.

create table if not exists public.payer_identities (
  wallet           text        primary key,               -- lowercase 0x address
  erc8004_agents   jsonb       not null default '[]'::jsonb,
  self_verified    boolean,                                -- null = the read failed
  self_agent_id    text,
  self_human_proof boolean,
  self_proof_fresh boolean,
  checked_at       timestamptz not null default now(),
  lookup_error     text
);

create table if not exists public.payment_client_info (
  transaction_id    uuid        primary key references public.transactions(id) on delete cascade,
  wallet            text,
  user_agent        text,
  declared_agent    text,
  declared_agent_id text,
  client_diag       jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists payment_client_info_wallet_idx on public.payment_client_info (wallet);

alter table public.payer_identities enable row level security;
alter table public.payment_client_info enable row level security;
revoke all on table public.payer_identities from anon, authenticated;
revoke all on table public.payment_client_info from anon, authenticated;
