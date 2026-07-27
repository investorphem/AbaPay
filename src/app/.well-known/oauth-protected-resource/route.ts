import { NextResponse } from 'next/server';

// ⚡ RFC 9728 — OAuth 2.0 Protected Resource Metadata.
//
// /api/mcp is the protected resource; this says which authorization server guards it. The
// client is sent here by the `resource_metadata` parameter in the WWW-Authenticate header
// that /api/mcp returns on a 401, and follows the `authorization_servers` link from here to
// the RFC 8414 document next door.

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
      resource: `${base}/api/mcp`,
      authorization_servers: [base],
      scopes_supported: ['pay_bill', 'check_balance'],
      bearer_methods_supported: ['header'],
      resource_name: 'AbaPay MCP',
      resource_documentation: `${base}/docs`,
    },
    { headers: CORS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
