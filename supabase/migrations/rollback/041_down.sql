-- Rollback for 041: removes onchain_windows(). stats.abapays.com falls back to all-time counters.

drop function if exists public.onchain_windows(text);
