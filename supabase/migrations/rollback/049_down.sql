-- Rollback for 049: drops the conversion log and the FX switches. Run only once no cNGN payout is
-- in flight (fx_conversions with status PENDING or SWAPPED).

drop table if exists public.fx_conversions;

alter table public.platform_settings
  drop column if exists fx_enabled,
  drop column if exists fx_max_usd_per_tx,
  drop column if exists fx_daily_cap_usd,
  drop column if exists cngn_payout_enabled;
