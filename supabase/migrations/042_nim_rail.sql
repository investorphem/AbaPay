-- The NIM rail (nim.abapays.com, the Nimiq Pay mini app; /api/pay/nim).
--
-- A NIM order is a transactions row with blockchain = 'NIMIQ' and token_used = 'NIM'. Like every
-- other row, amount_usdt is the crypto charged in token_used, so on these rows it is NIM. This
-- column keeps the NIM/USD price the order was quoted at, so the admin dashboard can show NIM
-- orders in US dollars next to the stablecoin ones. Null on every other row.

alter table public.transactions add column if not exists nim_usd_price numeric;
