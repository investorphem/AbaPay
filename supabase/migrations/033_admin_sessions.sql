-- ============================================================
-- AbaPay — revocable admin sessions
-- ============================================================
--
-- The admin dashboard used to send x-admin-address/signature/timestamp on every request: a
-- signature over "AbaPay Admin Login: <ts>" from the VAULT OWNER wallet, valid for 12 hours,
-- bound to no website and impossible to revoke. Anyone who captured those headers had 12h
-- of admin.
--
-- Now an admin signs in once (a Sign-In with Ethereum message, from the ops wallet, never the
-- owner) and gets an opaque session id in an HttpOnly, Secure, SameSite=Strict cookie. Only its
-- SHA-256 is stored here, so a database read can't be turned into a live session. A session
-- ends after 2h idle or 8h absolute, or when revoked (sign out, or "sign out everywhere").

create table if not exists public.admin_sessions (
  id_hash      text primary key,
  address      text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  user_agent   text,
  ip           text
);

create index if not exists admin_sessions_address_idx on public.admin_sessions (address);

alter table public.admin_sessions enable row level security;
-- No policies: service role only.
