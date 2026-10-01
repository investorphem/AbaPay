-- ============================================================
-- AbaPay — single-use nonces for Sign-In with Ethereum (EIP-4361)
-- ============================================================
--
-- Wallet-ownership proofs used to sign a bare "AbaPay Agent Action: <METHOD:PATH>: <ts>"
-- string. It named no website (a phishing site could ask for exactly that text and the wallet
-- couldn't warn), it carried no nonce (a captured signature replayed for 5 minutes), and it
-- said nothing a person could read. src/utils/walletAuth.ts now verifies SIWE messages instead,
-- and every one carries a nonce issued here by GET /api/auth/nonce.
--
--   purpose 'action'   one wallet mutation (link, PIN change, schedule). Consumed on use,
--                      atomically: uses_remaining is decremented by consume_auth_nonce and the
--                      signature is refused once it hits 0. A batch (one signature for N
--                      schedule POSTs) is issued with uses_remaining = N.
--   purpose 'session'  the read-only sign-in (History, assistant). Reused for its lifetime by
--                      design, so it is checked (issued, unexpired) but never decremented.

create table if not exists public.auth_nonces (
  nonce          text primary key,
  purpose        text not null check (purpose in ('action', 'session')),
  uses_remaining integer not null check (uses_remaining >= 0),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);

create index if not exists auth_nonces_expires_at_idx on public.auth_nonces (expires_at);

alter table public.auth_nonces enable row level security;
-- No policies: service role only.

-- Atomic check-and-use. TRUE only if the nonce was issued for this purpose, is unexpired, and
-- (for an action) still had a use left — which this call has now spent.
create or replace function public.consume_auth_nonce(p_nonce text, p_purpose text)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  hit boolean;
begin
  update public.auth_nonces
     set uses_remaining = uses_remaining - case when purpose = 'action' then 1 else 0 end
   where nonce = p_nonce
     and purpose = p_purpose
     and expires_at > now()
     and uses_remaining > 0
  returning true into hit;
  return coalesce(hit, false);
end;
$$;

revoke all on function public.consume_auth_nonce(text, text) from public, anon, authenticated;
