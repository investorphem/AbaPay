-- One-time reconciliation: closes out refund_queue rows that are stuck on PENDING even
-- though the corresponding transaction was already marked REFUNDED (i.e. it was actually
-- paid via the Ledger tab's older refund flow, which never updated refund_queue until now).
-- Safe to run more than once -- only touches rows where both conditions are still true.

update public.refund_queue
set
  status = 'COMPLETED',
  notes = coalesce(notes, '') || ' [reconciled: already refunded via Ledger tab]',
  completed_at = now()
where status = 'PENDING'
  and tx_hash in (
    select tx_hash from public.transactions where status = 'REFUNDED'
  );

-- Run this first to see what it WILL affect before running the update above, if you want
-- to double check:
--
-- select rq.id, rq.tx_hash, rq.wallet_address, rq.amount_crypto, rq.token_used
-- from public.refund_queue rq
-- join public.transactions t on t.tx_hash = rq.tx_hash
-- where rq.status = 'PENDING' and t.status = 'REFUNDED';
