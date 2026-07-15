-- Distinguishes which settlement rail a transaction used: the original on-chain contract
-- call (payBill / payBillFor), or the new x402 facilitator-settled path (main web app,
-- Celo + USDC only for now). This is a different axis from `source_channel` (which UI/bot
-- initiated the request) — a transaction has exactly one of each.
alter table public.transactions
  add column if not exists payment_method text not null default 'CONTRACT';
