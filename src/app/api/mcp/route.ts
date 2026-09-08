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
import { MCP_UI_CARD_URI, MCP_UI_CARD_RESOURCE, MCP_UI_CARD_HTML } from '@/lib/deai/mcpUiTemplates';

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
        // 🔴 TEMPORARY DIAGNOSTIC (round 2) — every server-side piece (initialize capabilities,
        // tools/list's _meta.ui, resources/read's HTML) has been hand-verified correct against
        // production, twice now, yet the card still isn't confirmed rendering after this
        // deploy. Round 1 of this same diagnostic (since removed) proved the earlier gap was a
        // stale client connection; this round targets what's left unverified — whether the
        // client is asking for the io.modelcontextprotocol/ui extension AT ALL this time, and
        // whether it ever calls resources/read afterward. Remove once resolved.
        console.log('[MCP][DIAG2] initialize — extensions:', JSON.stringify(params?.capabilities?.extensions), 'clientInfo:', JSON.stringify(params?.clientInfo));
        return rpcResult(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          // `resources: {}` because pay_bill/pay_bill_batch/transaction_history now reference a
          // `ui://` resource via `_meta.ui.resourceUri` (see mcpTools.ts) — MCP Apps (SEP-1865),
          // an open extension, not a first-party-only mechanism. Declared unconditionally: a
          // host that never negotiates the `io.modelcontextprotocol/ui` extension just never
          // calls resources/read and the tool behaves exactly as before (text ± PNG image),
          // per the spec's own graceful-degradation rule — no client capability check needed.
          //
          // 🔴 `tools: { listChanged: true }` — CONFIRMED LIVE BUG THIS ADDRESSES: shipping the
          // interactive card here did nothing for an already-connected client until the AbaPay
          // connector was manually disconnected and reconnected — verified against production
          // logs: three real tools/call requests hit /api/mcp in the same window a user tried a
          // fresh conversation, and NONE of them was a fresh `initialize` — the client was
          // reusing a connection (and its cached tools/list) established before this tool
          // metadata existed. Declaring listChanged + actually sending
          // notifications/tools/list_changed over the GET SSE stream below (see GET, and its
          // own comment) is the spec-correct fix — a client that holds that stream open gets
          // told to re-fetch tools/list without the user touching Settings at all.
          //
          // ⚠️ NOT A GUARANTEED FIX BY ITSELF: Anthropic's own MCP connector tracker has open,
          // acknowledged reports of a remote connector's tool list staying stale even across a
          // manual reconnect (anthropics/claude-ai-mcp#137, #476) — a caching issue on the
          // client/platform side this server cannot control. This is still the right thing to
          // implement (Claude Code already honors listChanged over a stream; other MCP clients
          // do too), but until that platform bug is fixed, "Refresh tools list" from the
          // connector's own ⋮ menu in Claude.ai remains the fastest manual fallback — lighter
          // than a full disconnect/reconnect, no re-authorization needed.
          capabilities: { tools: { listChanged: true }, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: "AbaPay: check a linked wallet's stablecoin balance, browse recent transaction history, pay a real bill (one recipient or many at once), or schedule one for later — Nigerian services (airtime, data, electricity, cable) or international airtime/data across 170+ countries — settled on-chain. Call describe_capabilities first. For DATA, CABLE, or EDUCATION, call list_plans before pay_bill/pay_bill_batch/schedule_bill and use one of its real returned codes as variation_code. For service: INTERNATIONAL, call list_international_options first (drills down country -> product type -> operator -> plan) and pass back its exact country/product_type_id/operator_id/variation_code — never guess any of these (INTERNATIONAL cannot be scheduled or batched; pay_bill only). A successful pay_bill returns a rich receipt (image card plus a shareable receipt link) alongside the confirmation text. Use transaction_history to answer 'what did I pay recently' without the human needing to open the app. When the human names 2+ recipients for airtime or data in one request, use pay_bill_batch (one PIN for the whole batch, up to 20 recipients) instead of calling pay_bill repeatedly. Authentication: OAuth 2.1 is supported and preferred — authorize once in the browser and this connection is remembered, so no api_key argument is ever needed again. The api_key created in the AbaPay app under Agent Hub -> MCP remains the fallback for clients that cannot do OAuth. Either way, pay_bill, pay_bill_batch, and schedule_bill ALWAYS require the PIN set when the key was created — OAuth does not remove it. Ask the human for their PIN on every single payment/batch/schedule creation — every single call, never reused from earlier in the conversation. pay_bill and pay_bill_batch execute IMMEDIATELY with no delay of their own — if the human asks to pay 'in N minutes', 'later', 'tomorrow', or on a recurring basis (e.g. 'every Tuesday'), do not call them now; use schedule_bill instead (it charges nothing itself — money only moves later, when the schedule fires and only if the wallet still has a funded allowance then; for multiple recipients, call schedule_bill once per recipient). Use list_schedules/cancel_schedule to view or remove standing schedules. Every call that moves or commits money (pay_bill, pay_bill_batch, schedule_bill) is rate-limited per credential on top of the PIN requirement — a 'too many calls' error means slow down and retry shortly, not that anything is broken.",
        });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });

      // MCP Apps (SEP-1865) resource handlers. Only one resource exists — the shared card
      // template — so `resources/list` is a fixed one-item array rather than anything paged.
      // Per spec, servers "MAY omit UI-only resources from resources/list" since tools already
      // point to them via `_meta.ui.resourceUri`; listed anyway for hosts that prefetch from
      // here rather than waiting for a tool call, and for basic discoverability.
      case 'resources/list':
        console.log('[MCP][DIAG2] resources/list called');
        return rpcResult(id, { resources: [MCP_UI_CARD_RESOURCE] });

      case 'resources/read': {
        const uri = params?.uri;
        console.log('[MCP][DIAG2] resources/read called for uri:', uri);
        if (uri !== MCP_UI_CARD_URI) {
          return rpcError(id, -32002, `Resource not found: ${uri}`);
        }
        return rpcResult(id, {
          contents: [{ uri: MCP_UI_CARD_URI, mimeType: 'text/html;profile=mcp-app', text: MCP_UI_CARD_HTML }],
        });
      }

      case 'tools/call': {
        const toolName = params?.name;
        if (!toolName || !TOOLS.some((t) => t.name === toolName)) {
          return rpcError(id, -32602, `Unknown tool: ${toolName}`);
        }
        // 🔴 TEMPORARY DIAGNOSTIC (round 2) — see the note on 'initialize'. Confirms this
        // specific request actually reached tools/call for a card-enabled tool, and with what
        // arguments — a re-call carrying `offset`/`chain`/`id` is the View itself paging or
        // refreshing; one without is the model's own first call.
        if (['pay_bill', 'pay_bill_batch', 'transaction_history', 'check_balance', 'list_schedules', 'cancel_schedule'].includes(toolName)) {
          console.log('[MCP][DIAG2] tools/call', toolName, JSON.stringify(params?.arguments));
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

// 🔴 THE BUG THIS FIXES: shipping a new tool (or new tool metadata, like MCP Apps' `_meta.ui`)
// did nothing for a client that had already connected before the deploy — see the long
// comment on 'initialize'`s `listChanged` capability for how that was confirmed live. GET now
// actually opens the SSE half of Streamable HTTP instead of refusing it, and pushes
// notifications/tools/list_changed the moment a client starts listening — a client holding
// this stream open when a deploy ships gets told to re-fetch tools/list without anyone
// touching Settings. A bare GET without `Accept: text/event-stream` is something else (a
// scanner's liveness probe) and still gets the plain JSON summary below, unchanged.
export const maxDuration = 300;

const SSE_HEARTBEAT_MS = 20_000;

export async function GET(req: Request) {
  const wantsStream = (req.headers.get('accept') || '').includes('text/event-stream');
  if (wantsStream) {
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream({
      start(controller) {
        const send = (payload: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
          } catch { /* controller already closed — nothing to do */ }
        };

        // Sent unconditionally on every new connection, not just after a real change — this
        // server is stateless serverless, with no way to know whether THIS client's cached
        // tools/list actually predates the last deploy. A client that re-fetches and gets
        // identical data back is harmless; a client that never re-fetches is the whole bug.
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

        // SSE connections behind a proxy/CDN get silently dropped if nothing crosses the wire
        // for a while — a comment-only ping (no `data:` line, so it's not a JSON-RPC message
        // and MUST be ignored by any spec-compliant parser) keeps it alive up to maxDuration.
        heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
        }, SSE_HEARTBEAT_MS);

        req.signal.addEventListener('abort', () => {
          if (heartbeat) clearInterval(heartbeat);
          try { controller.close(); } catch { /* already closed */ }
        });
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
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
