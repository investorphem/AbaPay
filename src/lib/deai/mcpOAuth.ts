import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import type { McpIdentity } from './mcpAuth';

// ⚡ OAUTH 2.1 FOR MCP — the sibling of mcpAuth.ts.
//
// mcpAuth.ts resolves an identity from a raw api_key the human types into every new
// conversation. This module resolves the SAME identity from a Bearer token the MCP client
// obtained once, in a browser, and now replays forever with zero further user action.
//
// The difference is purely how the connection is (re-)established. Once resolved, an OAuth
// identity is byte-for-byte the same McpIdentity an api_key produces, and goes through the
// exact same downstream gates — including the PIN, which is STILL required on every single
// pay_bill call. OAuth authorises the CONNECTION; the PIN authorises the SPEND. Same model
// the chat channels already have: linked once, PIN confirms every individual payment.
//
// HASHING: same reasoning as mcpAuth.ts's own note — these are 256-bit random secrets with
// no realistic guess space, so a plain SHA-256 lookup hash is correct. A slow KDF would buy
// nothing and cost latency on every tool call. Raw tokens are never stored, only returned
// once by the token endpoint.

const CODE_PREFIX = 'aba_code_';
const ACCESS_PREFIX = 'aba_at_';
const REFRESH_PREFIX = 'aba_rt_';
const CLIENT_PREFIX = 'aba_client_';

/** Authorization codes live 60 seconds — a client redeems one immediately or not at all. */
const CODE_TTL_SECONDS = 60;
/** 90 days. Low-privilege by construction: a token alone can read a balance, never spend. */
const ACCESS_TTL_SECONDS = 90 * 24 * 60 * 60;
/** 1 year, rotated on every use (OAuth 2.1 best practice for public clients). */
const REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;

export const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TTL_SECONDS;

// Same select list resolveMcpIdentity() uses — kept in one place so the two paths can never
// drift into returning differently-shaped identities.
const IDENTITY_COLUMNS =
  'id, wallet_address, approved_token, approved_chain, is_active, link_verified, failed_pin_attempts, locked_until, pin_hash';

export function generateClientId(): string {
  return `${CLIENT_PREFIX}${randomBytes(16).toString('hex')}`;
}

export function generateAuthCode(): string {
  return `${CODE_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function generateAccessToken(): string {
  return `${ACCESS_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function generateRefreshToken(): string {
  return `${REFRESH_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function hashOAuthToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * PKCE S256 verification (RFC 7636).
 *
 * 'plain' is deliberately NOT supported — it offers no protection at all (the "challenge"
 * IS the verifier, so anyone who intercepted the authorization request can redeem the code),
 * and OAuth 2.1 removes it. Claude's client uses S256.
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  // RFC 7636 §4.1 — the verifier is 43-128 chars of [A-Za-z0-9-._~].
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;

  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name: string | null;
  created_at?: string;
}

/**
 * A redirect URI must be https, or plain http ONLY on loopback (RFC 8252 §7.3 — a local
 * dev/desktop client can't get a certificate for 127.0.0.1). Anything else — http on a real
 * host, custom schemes, javascript:, data: — is refused at registration, so an attacker can
 * never register a client that redirects an authorization code somewhere unencrypted.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1')) return true;
  return false;
}

export async function registerClient(input: { redirect_uris: string[]; client_name?: string | null }): Promise<
  { ok: true; client: OAuthClient } | { ok: false; error: string; error_description: string }
> {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map((u) => String(u || '')) : [];
  if (uris.length === 0) {
    return { ok: false, error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array.' };
  }
  const bad = uris.find((u) => !isAllowedRedirectUri(u));
  if (bad) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      error_description: `redirect_uri "${bad}" is not allowed — must be https, or http on localhost/127.0.0.1.`,
    };
  }

  const client_id = generateClientId();
  const client_name = input.client_name ? String(input.client_name).slice(0, 120) : null;

  const { error } = await supabaseAdmin.from('mcp_oauth_clients').insert({ client_id, redirect_uris: uris, client_name });
  if (error) {
    console.error('[McpOAuth] client registration failed:', error.message);
    return { ok: false, error: 'server_error', error_description: 'Could not register client.' };
  }

  return { ok: true, client: { client_id, redirect_uris: uris, client_name } };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const { data } = await supabaseAdmin
    .from('mcp_oauth_clients')
    .select('client_id, redirect_uris, client_name, created_at')
    .eq('client_id', clientId)
    .maybeSingle();
  return (data as OAuthClient) || null;
}

export async function createAuthCode(input: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  agent_link_id: string;
}): Promise<string | null> {
  if (input.code_challenge_method !== 'S256') return null;

  const code = generateAuthCode();
  const { error } = await supabaseAdmin.from('mcp_oauth_codes').insert({
    code,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge,
    code_challenge_method: 'S256',
    agent_link_id: input.agent_link_id,
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
    used: false,
  });

  if (error) {
    console.error('[McpOAuth] auth code insert failed:', error.message);
    return null;
  }
  return code;
}

export type OAuthFailure = { ok: false; error: string; error_description: string };

/**
 * Redeem an authorization code exactly once.
 *
 * Every check here matters: an expired or already-redeemed code is dead, and the client_id
 * and redirect_uri must match what was ACTUALLY issued (not merely what the caller claims),
 * which is what stops a code leaked via a referrer/log from being redeemed by a different
 * client. PKCE then proves the redeemer is the same party that started the flow.
 */
export async function exchangeAuthCode(input: {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<{ ok: true; agent_link_id: string } | OAuthFailure> {
  const fail: OAuthFailure = { ok: false, error: 'invalid_grant', error_description: 'Invalid, expired, or already-used authorization code.' };
  if (!input.code) return fail;

  const { data } = await supabaseAdmin
    .from('mcp_oauth_codes')
    .select('code, client_id, redirect_uri, code_challenge, code_challenge_method, agent_link_id, expires_at, used')
    .eq('code', input.code)
    .maybeSingle();

  const row = data as any;
  if (!row) return fail;
  if (row.used) return fail;
  if (new Date(row.expires_at).getTime() <= Date.now()) return fail;
  if (row.client_id !== input.client_id) return fail;
  if (row.redirect_uri !== input.redirect_uri) return fail;
  if (row.code_challenge_method !== 'S256') return fail;
  if (!verifyPkce(input.code_verifier, row.code_challenge)) {
    return { ok: false, error: 'invalid_grant', error_description: 'PKCE verification failed.' };
  }

  // 🔒 SINGLE USE, ENFORCED BY THE DATABASE. The `.eq('used', false)` in the UPDATE is the
  // whole point — two concurrent redemptions of the same code both pass the read above, but
  // only one of them can flip the row, and the loser gets zero rows back and is rejected.
  // Checking `used` in application code alone would let both through.
  const { data: claimed } = await supabaseAdmin
    .from('mcp_oauth_codes')
    .update({ used: true })
    .eq('code', input.code)
    .eq('used', false)
    .select('code')
    .maybeSingle();

  if (!claimed) return fail;

  return { ok: true, agent_link_id: row.agent_link_id };
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Generates a token pair, stores only their hashes, and returns the RAW values — the one
 *  and only time they are ever visible to anyone but the client that receives them. */
export async function issueTokenPair(input: { client_id: string; agent_link_id: string }): Promise<TokenPair | null> {
  const access_token = generateAccessToken();
  const refresh_token = generateRefreshToken();
  const now = Date.now();

  const { error } = await supabaseAdmin.from('mcp_oauth_tokens').insert({
    access_token_hash: hashOAuthToken(access_token),
    refresh_token_hash: hashOAuthToken(refresh_token),
    client_id: input.client_id,
    agent_link_id: input.agent_link_id,
    access_expires_at: new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString(),
    revoked: false,
  });

  if (error) {
    console.error('[McpOAuth] token issue failed:', error.message);
    return null;
  }

  return { access_token, refresh_token, expires_in: ACCESS_TTL_SECONDS };
}

/**
 * Resolve a raw Bearer access token to the same McpIdentity shape resolveMcpIdentity()
 * returns for an api_key. Null on ANY failure — unknown token, revoked, expired, or the
 * underlying agent_link having since been deactivated/unlinked (which must instantly kill
 * every token issued against it, hence the join rather than a cached copy of the identity).
 */
export async function validateAccessToken(rawToken: string): Promise<McpIdentity | null> {
  if (!rawToken || !rawToken.startsWith(ACCESS_PREFIX)) return null;

  const { data } = await supabaseAdmin
    .from('mcp_oauth_tokens')
    .select('agent_link_id, access_expires_at, revoked')
    .eq('access_token_hash', hashOAuthToken(rawToken))
    .maybeSingle();

  const row = data as any;
  if (!row || row.revoked) return null;
  if (new Date(row.access_expires_at).getTime() <= Date.now()) return null;

  const { data: link } = await supabaseAdmin
    .from('agent_links')
    .select(IDENTITY_COLUMNS)
    .eq('id', row.agent_link_id)
    .eq('channel', 'MCP')
    .eq('is_active', true)
    .maybeSingle();

  return (link as unknown as McpIdentity) || null;
}

/**
 * Refresh-token grant, WITH ROTATION — the old pair is revoked and a brand new access +
 * refresh pair is issued. OAuth 2.1 requires this for public clients: a refresh token that
 * never changes is a permanent bearer credential sitting on a client that holds no secret,
 * and rotation means a stolen one stops working the moment the legitimate client next
 * refreshes (the theft also becomes detectable, rather than silent).
 */
export async function refreshAccessToken(
  rawRefreshToken: string
): Promise<{ ok: true; pair: TokenPair } | OAuthFailure> {
  const fail: OAuthFailure = { ok: false, error: 'invalid_grant', error_description: 'Invalid, expired, or revoked refresh token.' };
  if (!rawRefreshToken || !rawRefreshToken.startsWith(REFRESH_PREFIX)) return fail;

  const hash = hashOAuthToken(rawRefreshToken);
  const { data } = await supabaseAdmin
    .from('mcp_oauth_tokens')
    .select('id, client_id, agent_link_id, refresh_expires_at, revoked')
    .eq('refresh_token_hash', hash)
    .maybeSingle();

  const row = data as any;
  if (!row || row.revoked) return fail;
  if (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() <= Date.now()) return fail;

  // Revoke first, conditionally on it not already being revoked — same single-use race
  // protection as the auth code above, so two concurrent refreshes can't both mint a pair.
  const { data: revoked } = await supabaseAdmin
    .from('mcp_oauth_tokens')
    .update({ revoked: true })
    .eq('id', row.id)
    .eq('revoked', false)
    .select('id')
    .maybeSingle();

  if (!revoked) return fail;

  const pair = await issueTokenPair({ client_id: row.client_id, agent_link_id: row.agent_link_id });
  if (!pair) return { ok: false, error: 'server_error', error_description: 'Could not issue tokens.' };

  return { ok: true, pair };
}
