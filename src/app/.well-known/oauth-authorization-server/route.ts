import { NextResponse } from 'next/server';

// ⚡ RFC 8414 — OAuth 2.0 Authorization Server Metadata.
//
// This is the document an MCP client fetches to discover HOW to authorise against AbaPay.
// Claude's connector reads it (pointed here by the `resource_metadata` in the 401 that
// /api/mcp returns when a tool is called with no credential) and from it alone learns where
// to register, where to send the user's browser, and where to redeem the code — which is
// what makes "connect once, forever" possible with no configuration typed by the human.
//
// CORS is wide open on purpose: these are public, non-secret discovery documents, and a
// browser-based MCP client fetches them cross-origin. Nothing here is authenticated, so
// there is nothing for a permissive origin to leak.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';

  return NextResponse.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/api/oauth/authorize`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // S256 only — 'plain' provides no protection and is removed in OAuth 2.1.
      code_challenge_methods_supported: ['S256'],
      // Public clients: the MCP connector holds no secret, PKCE is the binding instead.
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['pay_bill', 'check_balance'],
    },
    { headers: CORS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
