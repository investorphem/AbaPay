import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isChannelEnabled } from '@/lib/serviceRules';
import { type McpIdentity } from '@/lib/deai/mcpAuth';
import { validateAccessToken } from '@/lib/deai/mcpOAuth';
import {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS,
  NEEDS_AUTH,
  WWW_AUTH_MISSING,
  WWW_AUTH_INVALID,
  callTool,
  errorResult,
} from '@/lib/deai/mcpTools';

// ⚡ MCP SERVER — lets an AI agent (Claude, or any MCP-speaking client) check a balance or
// pay a bill on behalf of a wallet that has explicitly linked and PIN-protected an API key
// in the AbaPay app's Agent Hub (channel = 'MCP'). This is a FOURTH way in to the exact
// same execution engine WhatsApp/Telegram/X already use — same on-chain allowance ceiling,
// same PIN gate with escalating lockout, same kill switches, same operator spend caps, same
// discount engine, same out-of-band spend alert. Nothing here is a new trust boundary; it's
// the existing one, reached over JSON-RPC instead of a chat message.
//
// Transport: MCP "Streamable HTTP" (see modelcontextprotocol.io) — a single POST endpoint
// speaking JSON-RPC 2.0 (initialize / tools/list / tools/call). We never need to push a
// message to the client outside of a request/response, so every response here is a single
// JSON object rather than an SSE stream — that's spec-compliant, not a shortcut.
//
// The tools this server exposes live in src/lib/deai/mcpTools.ts — shared with /api/a2a so
// both protocols hit one implementation and one trust boundary. This file is only transport.

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** HTTP 401 + the WWW-Authenticate pointer an MCP client follows to start the OAuth flow. */
function unauthorized(id: unknown, wwwAuthenticate: string, message: string) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } },
    { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } }
  );
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'mcp', 60, 60);
  if (limited) return limited;

  // 🔐 Bearer token, if the client has one. Resolved ONCE per request, before any dispatch,
  // and passed down explicitly. A token that's present but doesn't resolve is a hard 401 —
  // an expired or revoked token must tell the client to re-authorise, not silently degrade
  // into "please type your api_key", which is the exact behaviour we're removing.
  const authHeader = req.headers.get('authorization') || '';
  let oauthIdentity: McpIdentity | null = null;
  if (/^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    oauthIdentity = await validateAccessToken(token);
    if (!oauthIdentity) {
      return unauthorized(null, WWW_AUTH_INVALID, 'Invalid or expired access token. Re-authorize the AbaPay connector.');
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error: invalid JSON.');
  }

  const { id, method, params } = body || {};

  // Notifications (no id) get no reply body — 202 Accepted, per the MCP spec.
  if (id === undefined && typeof method === 'string') {
    return new NextResponse(null, { status: 202 });
  }

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: "AbaPay: check a linked wallet's stablecoin balance, browse recent transaction history, pay a real bill, or schedule one for later — Nigerian services (airtime, data, electricity, cable) or international airtime/data across 170+ countries — settled on-chain. Call describe_capabilities first. For DATA, CABLE, or EDUCATION, call list_plans before pay_bill/schedule_bill and use one of its real returned codes as variation_code. For service: INTERNATIONAL, call list_international_options first (drills down country -> product type -> operator -> plan) and pass back its exact country/product_type_id/operator_id/variation_code — never guess any of these (INTERNATIONAL cannot be scheduled; pay_bill only). A successful pay_bill returns a rich receipt (image card plus a shareable receipt link) alongside the confirmation text. Use transaction_history to answer 'what did I pay recently' without the human needing to open the app. Authentication: OAuth 2.1 is supported and preferred — authorize once in the browser and this connection is remembered, so no api_key argument is ever needed again. The api_key created in the AbaPay app under Agent Hub -> MCP remains the fallback for clients that cannot do OAuth. Either way, pay_bill and schedule_bill ALWAYS require the PIN set when the key was created — OAuth does not remove it. Ask the human for their PIN on every single payment/schedule creation — every single call, never reused from earlier in the conversation. pay_bill executes IMMEDIATELY with no delay of its own — if the human asks to pay 'in N minutes', 'later', 'tomorrow', or on a recurring basis (e.g. 'every Tuesday'), do not call pay_bill now; use schedule_bill instead (it charges nothing itself — money only moves later, when the schedule fires and only if the wallet still has a funded allowance then). Use list_schedules/cancel_schedule to view or remove standing schedules.",
        });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });

      case 'tools/call': {
        const toolName = params?.name;
        if (!toolName || !TOOLS.some((t) => t.name === toolName)) {
          return rpcError(id, -32602, `Unknown tool: ${toolName}`);
        }
        // 🔴 OPERATOR EMERGENCY BRAKE — same per-channel pause as WhatsApp/Telegram/X (see
        // isChannelEnabled in serviceRules.ts). A normal in-band tool error, not a transport
        // failure — the agent should be able to tell the human clearly what's going on.
        if (!(await isChannelEnabled('MCP'))) {
          return rpcResult(id, errorResult('AbaPay MCP is temporarily paused for maintenance. Please try again shortly, or use the AbaPay app.'));
        }
        const result = await callTool(toolName, params?.arguments || {}, oauthIdentity);
        // The one and only in-band condition promoted to an HTTP-level failure: a tool that
        // needs an identity was called with none at all. Everything else — wrong key, wrong
        // PIN, bad arguments, insufficient allowance — stays a normal tool result.
        if (result === NEEDS_AUTH) {
          return unauthorized(
            id,
            WWW_AUTH_MISSING,
            'Authorization required. Connect the AbaPay MCP server via OAuth, or pass an api_key argument.'
          );
        }
        return rpcResult(id, result);
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err: any) {
    console.error('[MCP] request failed:', err?.message);
    return rpcError(id, -32603, 'Internal error.');
  }
}

// GET opens a server-push SSE stream in the Streamable HTTP spec — we never push anything
// outside of a request/response, so 405 is the spec-compliant reply to a REAL MCP client
// asking for one (identifiable by `Accept: text/event-stream`, exactly as the spec says a
// client requesting the stream must send). A bare GET without that header is something else
// probing liveness — e.g. a scanner's generic health-check — and 405 there just reads as
// "broken endpoint" to a prober that never intended to open a stream in the first place, so
// it gets a plain 200 describing the server instead.
export async function GET(req: Request) {
  const wantsStream = (req.headers.get('accept') || '').includes('text/event-stream');
  if (wantsStream) {
    return NextResponse.json(
      { error: 'This MCP server does not support the GET/SSE stream half of Streamable HTTP — use POST.' },
      { status: 405, headers: { Allow: 'POST' } }
    );
  }
  return NextResponse.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocol: 'mcp',
    protocolVersion: PROTOCOL_VERSION,
    transport: 'streamable-http',
    tools: TOOLS.map((t) => t.name),
  });
}
