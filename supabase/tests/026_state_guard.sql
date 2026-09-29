-- Tests for 026_transaction_state_guard.sql.
--
-- Runs entirely inside one transaction that is ROLLED BACK, against a session-temporary copy of
-- public.transactions — it never touches a real row. Requires public.transactions_state_guard()
-- to exist (apply 026 first, or run this after `create or replace function ...` from 026 inside
-- the same transaction for a dry run).
--
-- Every "ok" case below is a write the CURRENT application code performs; every "blocked" case
-- is a move the /api/pay replay needs. A failure raises and aborts with the case name.

begin;

create temp table t_guard (like public.transactions including all) on commit drop;
create trigger t_guard_state_guard before update on t_guard
  for each row execute function public.transactions_state_guard();

create function pg_temp.expect_ok(label text, stmt text) returns void language plpgsql as $$
begin
  execute stmt;
exception when others then
  raise exception 'FAIL [%]: expected success, got: %', label, sqlerrm;
end $$;

create function pg_temp.expect_blocked(label text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlerrm like 'AbaPay state guard:%' then return; end if;
    raise exception 'FAIL [%]: blocked for the wrong reason: %', label, sqlerrm;
  end;
  raise exception 'FAIL [%]: expected the guard to block this write', label;
end $$;

create function pg_temp.seed(h text, st text, rid text) returns void language sql as $$
  insert into t_guard (wallet_address, service_category, network, account_number, amount_usdt,
                       amount_naira, fee_naira, discount_ngn, tx_hash, status, request_id)
  values ('0xabc', 'AIRTIME', 'mtn', '08000000000', 1, 1340, 0, 0, h, st, rid);
$$;

-- The exact shape of /api/pay's intent_only write (status PENDING + a fresh request_id).
create function pg_temp.attack(h text) returns text language sql as $$
  select format($f$insert into t_guard (wallet_address, service_category, network, account_number,
      amount_usdt, amount_naira, fee_naira, discount_ngn, tx_hash, status, request_id)
    values ('0xattacker', 'AIRTIME', 'mtn', '08000000000', 1, 1340, 0, 0, %L, 'PENDING', 'rid_replay')
    on conflict (tx_hash) do update set status = excluded.status, request_id = excluded.request_id,
      wallet_address = excluded.wallet_address$f$, h);
$$;

-- ── legitimate writes (must succeed) ────────────────────────────────────────────────────────
select pg_temp.seed('preflight_ok1', 'PENDING', 'rid1');
select pg_temp.expect_ok('frontend/webhook rename preflight -> real hash',
  $$update t_guard set tx_hash = '0xok1' where tx_hash = 'preflight_ok1'$$);
select pg_temp.expect_ok('/api/pay lock PENDING -> PROCESSING with new request_id',
  $$update t_guard set status = 'PROCESSING', request_id = 'rid1b' where tx_hash = '0xok1' and status = 'PENDING'$$);
select pg_temp.expect_ok('vend.ts timeout PROCESSING -> PENDING, request_id unchanged',
  $$update t_guard set status = 'PENDING' where tx_hash = '0xok1'$$);
select pg_temp.expect_ok('re-lock PENDING -> PROCESSING',
  $$update t_guard set status = 'PROCESSING' where tx_hash = '0xok1'$$);
select pg_temp.expect_ok('vend success PROCESSING -> SUCCESS',
  $$update t_guard set status = 'SUCCESS', purchased_code = '1234' where tx_hash = '0xok1'$$);
select pg_temp.expect_ok('VTpass reversal SUCCESS -> REVERSED_NEEDS_REFUND',
  $$update t_guard set status = 'REVERSED_NEEDS_REFUND' where tx_hash = '0xok1'$$);
select pg_temp.expect_ok('refund REVERSED_NEEDS_REFUND -> REFUNDED',
  $$update t_guard set status = 'REFUNDED', refund_hash = '0xrefund' where tx_hash = '0xok1'$$);

select pg_temp.seed('preflight_ok2', 'PENDING', 'rid2');
select pg_temp.expect_ok('cleanupPreflights PENDING -> EXPIRED',
  $$update t_guard set status = 'EXPIRED', error_code = 'PREFLIGHT_UNCONFIRMED' where tx_hash = 'preflight_ok2'$$);

select pg_temp.seed('preflight_ok3', 'PENDING', 'rid3');
select pg_temp.expect_ok('upsert onto the SAME pending preflight (retry of intent_only)',
  $$insert into t_guard (wallet_address, service_category, network, account_number, amount_usdt, amount_naira,
      fee_naira, discount_ngn, tx_hash, status, request_id)
    values ('0xabc','AIRTIME','mtn','08000000000',1,1340,0,0,'preflight_ok3','PENDING','rid3b')
    on conflict (tx_hash) do update set status = excluded.status, request_id = excluded.request_id$$);
select pg_temp.expect_ok('batch.ts never-broadcast PENDING -> FAILED_PAYMENT',
  $$update t_guard set status = 'FAILED_PAYMENT', error_code = 'AGENT_PREFLIGHT_FAILED' where tx_hash = 'preflight_ok3'$$);

select pg_temp.seed('0xok4', 'PROCESSING', 'rid4');
select pg_temp.expect_ok('vend rejection PROCESSING -> FAILED_VENDING',
  $$update t_guard set status = 'FAILED_VENDING', error_code = '018' where tx_hash = '0xok4'$$);
select pg_temp.expect_ok('refund completion FAILED_VENDING -> REFUNDED',
  $$update t_guard set status = 'REFUNDED', refund_hash = '0xr4' where tx_hash = '0xok4'$$);
select pg_temp.expect_ok('column edit on a terminal row with status unchanged',
  $$update t_guard set api_response = 'note' where tx_hash = '0xok4'$$);

select pg_temp.seed('0xok5', 'PENDING', 'rid5');
select pg_temp.expect_ok('Alchemy webhook check PENDING -> FAILED_VENDING (reverted tx)',
  $$update t_guard set status = 'FAILED_VENDING', error_code = 'REVERTED' where tx_hash = '0xok5'$$);

select pg_temp.expect_ok('x402 fresh insert of a settled hash',
  $$insert into t_guard (wallet_address, service_category, network, account_number, amount_usdt, amount_naira,
      fee_naira, discount_ngn, tx_hash, status, request_id, payment_method)
    values ('0xabc','AIRTIME','mtn','08000000000',1,1340,0,0,'0xx402','PENDING','rid6','X402')
    on conflict (tx_hash) do nothing$$);

-- ── replay / regression attempts (must be blocked) ──────────────────────────────────────────
select pg_temp.seed('0xdone', 'SUCCESS', 'rid_orig');
select pg_temp.expect_blocked('REPLAY: intent_only upsert over a SUCCESS row', pg_temp.attack('0xdone'));

select pg_temp.seed('0xrefunded', 'REFUNDED', 'rid_r');
select pg_temp.expect_blocked('REPLAY: intent_only upsert over a REFUNDED row', pg_temp.attack('0xrefunded'));

select pg_temp.seed('0xfailed', 'FAILED_VENDING', 'rid_f');
select pg_temp.expect_blocked('REPLAY: intent_only upsert over a FAILED_VENDING row', pg_temp.attack('0xfailed'));

select pg_temp.seed('0xstuckbank', 'PROCESSING', 'rid_b');
select pg_temp.expect_blocked('REPLAY: intent_only upsert over a PROCESSING row (new request_id)', pg_temp.attack('0xstuckbank'));

select pg_temp.seed('0xexpired', 'EXPIRED', 'rid_e');
select pg_temp.expect_blocked('EXPIRED -> PENDING', $$update t_guard set status = 'PENDING' where tx_hash = '0xexpired'$$);

select pg_temp.expect_blocked('SUCCESS -> PROCESSING', $$update t_guard set status = 'PROCESSING' where tx_hash = '0xdone'$$);
select pg_temp.expect_blocked('REFUNDED -> SUCCESS', $$update t_guard set status = 'SUCCESS' where tx_hash = '0xrefunded'$$);
select pg_temp.expect_blocked('FAILED_VENDING -> PENDING', $$update t_guard set status = 'PENDING' where tx_hash = '0xfailed'$$);
select pg_temp.expect_blocked('rename a real (non-preflight) hash', $$update t_guard set tx_hash = '0xother' where tx_hash = '0xdone'$$);
select pg_temp.expect_blocked('rewrite request_id on a SUCCESS row', $$update t_guard set request_id = 'rid_new' where tx_hash = '0xdone'$$);

-- Nothing about the blocked attempts may have stuck.
do $$
begin
  if (select status from t_guard where tx_hash = '0xdone') <> 'SUCCESS'
     or (select request_id from t_guard where tx_hash = '0xdone') <> 'rid_orig'
     or (select wallet_address from t_guard where tx_hash = '0xdone') <> '0xabc' then
    raise exception 'FAIL: a blocked write modified the SUCCESS row';
  end if;
end $$;

select 'ALL 026 STATE GUARD TESTS PASSED' as result;

rollback;
