-- ⚡ OAUTH 2.1 FOR THE MCP CONNECTOR — so an MCP client (Claude) authorises ONCE in a
-- browser and every future conversation presents a Bearer token automatically, instead of
-- the human retyping their api_key into every brand-new chat.
--
-- WHAT THIS IS NOT: a replacement for the PIN. The PIN is still required on EVERY pay_bill
-- call, exactly as it is on Telegram/WhatsApp. OAuth only removes the re-entry of the
-- api_key needed to re-establish the CONNECTION — it never authorises a spend on its own.
-- That's why a 90-day access token is fine here: on its own it can read a balance, and
-- nothing more.
--
-- The anchor for all three tables is agent_links.id (agent_link_id) — the SAME identity row
-- resolveMcpIdentity() returns for a raw api_key. An OAuth token is therefore just a second
-- way to arrive at an existing link, not a new trust boundary: the on-chain allowance, the
-- PIN gate with escalating lockout, and every operator kill switch still apply unchanged.
--
-- PUBLIC CLIENTS ONLY (PKCE, no client_secret) — this is how Claude's MCP Dynamic Client
-- Registration actually works. A client that holds no secret cannot have one leak; PKCE
-- (S256) is what binds the authorization code to the client that requested it.

-- Dynamically registered MCP clients (RFC 7591). No client_secret column exists on purpose.
create table if not exists public.mcp_oauth_clients (
  client_id      text primary key,
  redirect_uris  text[] not null,
  client_name    text,
  created_at     timestamptz not null default timezone('utc', now())
);

-- Short-lived, single-use authorization codes (RFC 6749 §4.1 + PKCE RFC 7636).
-- 60-second expiry: the code is redeemed by the client the instant it lands on the redirect
-- URI, so anything longer is only ever useful to someone who stole it.
create table if not exists public.mcp_oauth_codes (
  code                  text primary key,
  client_id             text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri          text not null,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  agent_link_id         uuid not null references public.agent_links(id) on delete cascade,
  expires_at            timestamptz not null,
  used                  boolean not null default false,
  created_at            timestamptz not null default timezone('utc', now())
);

-- Issued token pairs. Only HASHES are stored — the raw access/refresh tokens are returned
-- to the client exactly once, at the token endpoint, and are never recoverable after that.
-- Same reasoning as agent_links.channel_user_id for MCP api_keys (see mcpAuth.ts): these are
-- 256-bit random secrets with no realistic guess space, so a fast SHA-256 lookup hash is the
-- correct choice — a slow KDF would only add latency to every single tool call.
create table if not exists public.mcp_oauth_tokens (
  id                 uuid primary key default gen_random_uuid(),
  access_token_hash  text not null unique,
  refresh_token_hash text unique,
  client_id          text references public.mcp_oauth_clients(client_id) on delete cascade,
  agent_link_id      uuid not null references public.agent_links(id) on delete cascade,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz,
  revoked            boolean not null default false,
  created_at         timestamptz not null default timezone('utc', now())
);

-- Lookup paths that run on the hot path of every authenticated tool call.
create index if not exists idx_mcp_oauth_codes_client on public.mcp_oauth_codes (client_id);
create index if not exists idx_mcp_oauth_codes_link on public.mcp_oauth_codes (agent_link_id);
create index if not exists idx_mcp_oauth_tokens_access on public.mcp_oauth_tokens (access_token_hash);
create index if not exists idx_mcp_oauth_tokens_refresh on public.mcp_oauth_tokens (refresh_token_hash);
create index if not exists idx_mcp_oauth_tokens_link on public.mcp_oauth_tokens (agent_link_id);

-- Service-role only, like every other table here — nothing in these three is ever read by
-- an anon client.
alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes enable row level security;
alter table public.mcp_oauth_tokens enable row level security;
