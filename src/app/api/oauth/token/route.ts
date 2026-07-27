import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { exchangeAuthCode, issueTokenPair, refreshAccessToken } from '@/lib/deai/mcpOAuth';

// ⚡ THE TOKEN ENDPOINT — where an authorization code becomes a Bearer token, and where an
// expiring token renews itself so the user never sees this flow a second time.
//
// CONTENT TYPE: OAuth 2.0 (RFC 6749 §4.1.3) specifies application/x-www-form-urlencoded, and
// that is what Claude's connector sends. JSON is also accepted because some MCP clients send
// it anyway and there is no reason to fail a request we understand perfectly well.
//
// NO CLIENT AUTHENTICATION: these are public clients holding no secret
// (token_endpoint_auth_method: "none"). PKCE is what proves the redeemer is the same party
// that started the flow — see verifyPkce/exchangeAuthCode in mcpOAuth.ts.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

// Token responses must never be cached — RFC 6749 §5.1 says so explicitly, and a cached
// bearer token in a shared proxy is exactly as bad as it sounds.
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache', ...CORS };

function oauthError(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status, headers: NO_STORE });
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  const out: Record<string, string> = {};

  if (type.includes('application/json')) {
    const body = await req.json();
    for (const [k, v] of Object.entries(body || {})) out[k] = String(v ?? '');
    return out;
  }

  // Handles both x-www-form-urlencoded and multipart/form-data.
  const form = await req.formData();
  for (const [k, v] of form.entries()) out[k] = String(v ?? '');
  return out;
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'oauth-token', 60, 300);
  if (limited) return limited;

  let params: Record<string, string>;
  try {
    params = await readParams(req);
  } catch {
    return oauthError('invalid_request', 'Body must be application/x-www-form-urlencoded or JSON.');
  }

  const grantType = params.grant_type || '';

  if (grantType === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = params;
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return oauthError(
        'invalid_request',
        'code, redirect_uri, client_id and code_verifier are all required for grant_type=authorization_code.'
      );
    }

    const exchanged = await exchangeAuthCode({ code, client_id, redirect_uri, code_verifier });
    if (!exchanged.ok) return oauthError(exchanged.error, exchanged.error_description);

    const pair = await issueTokenPair({ client_id, agent_link_id: exchanged.agent_link_id });
    if (!pair) return oauthError('server_error', 'Could not issue tokens.', 500);

    return NextResponse.json(
      {
        access_token: pair.access_token,
        token_type: 'Bearer',
        expires_in: pair.expires_in,
        refresh_token: pair.refresh_token,
        scope: 'pay_bill check_balance',
      },
      { headers: NO_STORE }
    );
  }

  if (grantType === 'refresh_token') {
    const { refresh_token } = params;
    if (!refresh_token) {
      return oauthError('invalid_request', 'refresh_token is required for grant_type=refresh_token.');
    }

    // The refresh token is ROTATED — the response carries a new one and the old is dead the
    // moment this succeeds. See refreshAccessToken() for why that matters for public clients.
    const refreshed = await refreshAccessToken(refresh_token);
    if (!refreshed.ok) return oauthError(refreshed.error, refreshed.error_description, refreshed.error === 'server_error' ? 500 : 400);

    return NextResponse.json(
      {
        access_token: refreshed.pair.access_token,
        token_type: 'Bearer',
        expires_in: refreshed.pair.expires_in,
        refresh_token: refreshed.pair.refresh_token,
        scope: 'pay_bill check_balance',
      },
      { headers: NO_STORE }
    );
  }

  return oauthError(
    'unsupported_grant_type',
    `grant_type "${grantType || '(missing)'}" is not supported. Use authorization_code or refresh_token.`
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
