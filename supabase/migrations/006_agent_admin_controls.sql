-- Operator controls for the DeAI agent. These matter far more now that the agent can SPEND.
-- An operator needs to halt autonomous behaviour instantly, without a redeploy and without a
-- contract call.
--
-- NOTE: these are OPERATIONAL controls layered ON TOP of the on-chain guarantees. Even if
-- every one were bypassed, AbaPayV3 still refuses to spend beyond each user's signed
-- allowance. Defence in depth — not the only defence.

alter table public.platform_settings
  add column if not exists agent_enabled boolean not null default true,
  add column if not exists agent_autonomous_enabled boolean not null default true,
  add column if not exists agent_max_ngn_per_tx numeric not null default 50000,
  add column if not exists agent_daily_cap_ngn numeric not null default 100000,
  add column if not exists ai_chat_enabled boolean not null default true;
