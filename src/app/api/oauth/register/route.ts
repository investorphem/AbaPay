import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { registerClient } from '@/lib/deai/mcpOAuth';

// ⚡ RFC 7591 — Dynamic Client Registration.
//
// An MCP connector has nobody to ask for a client_id; it registers itself the first time a
// user connects. That's the point — it removes the "paste this client id and secret" step
// that would otherwise be exactly the manual configuration OAuth is here to delete.
//
// WHAT REGISTRATION DOES AND DOESN'T GRANT: nothing. A client_id is not a credential and
// gives access to no one's account — it only names a set of redirect URIs. The gate that
// matters is the authorize page, where a real human must supply a real api_key AND the
// correct PIN before any code is issued. So open registration is safe here in a way it
// would not be if a client_id alone conferred anything.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'oauth-register', 20, 300);
  if (limited) return limited;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'Body must be JSON.' },
      { status: 400, headers: CORS }
    );
  }

  const redirectUris = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.some((u: any) => typeof u !== 'string' || !u)) {
    return NextResponse.json(
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array of strings.' },
      { status: 400, headers: CORS }
    );
  }

  // Every other RFC 7591 field (client_uri, logo_uri, contacts, scope, software_id…) is
  // accepted and ignored — a registration must not fail because a client sent metadata we
  // simply have no use for.
  const result = await registerClient({
    redirect_uris: redirectUris,
    client_name: body?.client_name || null,
  });

  if (!result.ok) {
    const status = result.error === 'server_error' ? 500 : 400;
    return NextResponse.json({ error: result.error, error_description: result.error_description }, { status, headers: CORS });
  }

  return NextResponse.json(
    {
      client_id: result.client.client_id,
      redirect_uris: result.client.redirect_uris,
      client_name: result.client.client_name,
      // Public client — no secret is issued, and none is expected at the token endpoint.
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status: 201, headers: CORS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
