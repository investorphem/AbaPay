-- Rollback for 048: drops the bank payout table and the agent control columns. Run only once no
-- order is AWAITING_PAYOUT: those orders would lose their payout record.

drop table if exists public.bank_payouts;

alter table public.transactions
  drop column if exists self_agent_id,
  drop column if exists self_agent_address;

alter table public.platform_settings
  drop column if exists agent_ext_max_ngn_per_tx,
  drop column if exists agent_ext_daily_cap_ngn,
  drop column if exists verified_agent_discounts_enabled,
  drop column if exists verified_agent_fee_waiver_enabled,
  drop column if exists verified_agent_higher_limits_enabled,
  drop column if exists verified_agent_max_ngn_per_tx,
  drop column if exists verified_agent_daily_cap_ngn,
  drop column if exists verified_agent_bank_enabled;
