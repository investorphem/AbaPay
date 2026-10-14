-- Rollback for 042: drops the NIM quote price. NIM rows keep their NIM amount in amount_usdt.

alter table public.transactions drop column if exists nim_usd_price;
