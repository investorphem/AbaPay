import 'server-only';
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isChannelEnabled } from '@/lib/serviceRules';
import { resolveMcpIdentity, type McpIdentity } from '@/lib/deai/mcpAuth';
import { validateAccessToken } from '@/lib/deai/mcpOAuth';
import { TOOLS, NEEDS_AUTH, WWW_AUTH_MISSING, WWW_AUTH_INVALID, callTool } from '@/lib/deai/mcpTools';

// ⚡ A2A SERVER — AbaPay over the Agent2Agent protocol (a2a-protocol.org), a FIFTH way in to
// the same execution engine behind WhatsApp/Telegram/X/MCP. Discovery document lives at
// /.well-known/agent-card.json.
//
// 🔴 SAME TRUST BOUNDARY, NEW TRANSPORT. Every skill here dispatches through the shared
// callTool() in src/lib/deai/mcpTools.ts — the identical function /api/mcp calls. A2A gets no
// private path to money: the PIN gate with escalating lockout, the on-chain allowance ceiling,
// the kill switches and the operator spend caps all still apply, because they live below this
// file, not in it. Adding a protocol changes how an agent asks, never what it may do.
//
// 🔴 WHY THERE IS NO LLM IN THIS PATH. Chat channels route free text through parseIntent()
// (an Anthropic call) because a human typed it. A2A is machine-to-machine, and a peer agent
// asking us to move money must say exactly what it means — so invocation is a structured
// DataPart carrying { skill, args }, validated against the same TOOLS schema MCP publishes.
// A text part gets the skill catalogue back instead of a guess. Re-interpreting "send 5000" with
// a language model in an agent-to-agent PAYMENT path would add a failure mode with no upside.

// A2A JSON-RPC error codes (spec §8).
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
const ERR_UNSUPPORTED_OPERATION = -32004;

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function unauthorized(id: unknown, wwwAuthenticate: string, message: string) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } },
    { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } }
  );
}

/** An A2A agent Message — what every synchronous skill here returns (no Task lifecycle). */
function agentMessage(parts: unknown[], contextId?: string) {
  return {
    kind: 'message',
    role: 'agent',
    messageId: randomUUID(),
    ...(contextId ? { contextId } : {}),
    parts,
  };
}

/**
 * Translate an MCP tool result into A2A parts.
 *
 * MCP content blocks and A2A parts describe the same thing with different field names, so the
 * mapping is mechanical: text→TextPart, image→FilePart with base64 bytes. The raw tool result
 * rides along as a DataPart so a peer agent can act on structured output instead of re-parsing
 * prose — the whole reason to prefer A2A over scraping a chat reply.
 */
function partsFromToolResult(result: any): unknown[] {
  const parts: unknown[] = [];
  for (const block of result?.content ?? []) {
    if (block?.type === 'text') {
      parts.push({ kind: 'text', text: block.text });
    } else if (block?.type === 'image') {
      parts.push({
        kind: 'file',
        file: { name: 'receipt.png', mimeType: block.mimeType || 'image/png', bytes: block.data },
      });
    }
  }
  parts.push({ kind: 'data', data: { isError: result?.isError === true, raw: result } });
  return parts;
}

/** The skill catalogue, returned when a peer sends prose instead of a structured invocation. */
function catalogueParts(): unknown[] {
  return [
    {
      kind: 'text',
      text:
        'AbaPay speaks structured A2A. Send a DataPart shaped { "skill": "<id>", "args": { … } } ' +
        'rather than free text — this is a payment agent, so invocations are taken literally and ' +
        'never inferred. Available skills are in the accompanying data part, and each one\'s ' +
        'JSON Schema is published at /.well-known/agent-card.json.',
    },
    {
      kind: 'data',
      data: {
        skills: (TOOLS as any[]).map((t) => ({
          id: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    },
  ];
}

/**
 * Resolve the caller from the Authorization header.
 *
 * Accepts BOTH credentials MCP accepts, distinguished by prefix: an Agent Hub key is literally
 * `aba_mcp_…`, anything else is treated as an OAuth 2.1 access token. A2A has no per-call
 * `api_key` argument the way MCP tools do, so the header is the only place a credential can
 * arrive — hence both forms are honoured here rather than forcing peers through OAuth.
 *
 * Returns `undefined` for "no credential offered" and `null` for "offered one, it did not
 * resolve" — the caller turns only the latter into a hard 401, mirroring /api/mcp's rule that a
 * WRONG credential is not the same condition as a MISSING one.
 */
async function identityFromHeader(req: Request): Promise<McpIdentity | null | undefined> {
  const header = req.headers.get('authorization') || '';
  if (!/^Bearer\s+/i.test(header)) return undefined;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return undefined;
  return token.startsWith('aba_mcp_') ? await resolveMcpIdentity(token) : await validateAccessToken(token);
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'a2a', 60, 60);
  if (limited) return limited;

  const identity = await identityFromHeader(req);
  if (identity === null) {
    return unauthorized(null, WWW_AUTH_INVALID, 'Invalid or expired credential. Re-authorize the AbaPay A2A connection.');
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, ERR_PARSE, 'Parse error: invalid JSON.');
  }

  const { id, method, params } = body || {};
  if (typeof method !== 'string') {
    return rpcError(id, ERR_INVALID_REQUEST, 'Invalid request: "method" is required.');
  }

  try {
    switch (method) {
      case 'message/send': {
        // 🔴 OPERATOR EMERGENCY BRAKE — its own switch, not MCP's. An operator pausing the MCP
        // connector must not silently pause A2A too (or vice versa); they are separate surfaces
        // with separate blast radii. Missing key = enabled, same default as every other channel.
        if (!(await isChannelEnabled('A2A'))) {
          return rpcResult(
            id,
            agentMessage(
              [{ kind: 'text', text: 'AbaPay A2A is temporarily paused for maintenance. Please try again shortly.' }],
              params?.message?.contextId
            )
          );
        }

        const message = params?.message;
        if (!message || !Array.isArray(message.parts)) {
          return rpcError(id, ERR_INVALID_PARAMS, 'Invalid params: "message.parts" is required.');
        }
        const contextId = message.contextId;

        // A structured invocation is a DataPart naming a skill. Anything else is prose.
        const invocation = message.parts.find(
          (p: any) => p?.kind === 'data' && typeof p?.data?.skill === 'string'
        );
        if (!invocation) {
          return rpcResult(id, agentMessage(catalogueParts(), contextId));
        }

        const skill = invocation.data.skill;
        if (!(TOOLS as any[]).some((t) => t.name === skill)) {
          return rpcError(id, ERR_INVALID_PARAMS, `Unknown skill: ${skill}`);
        }

        const result = await callTool(skill, invocation.data.args || {}, identity ?? null);
        if (result === NEEDS_AUTH) {
          return unauthorized(
            id,
            WWW_AUTH_MISSING,
            'Authorization required. Present an AbaPay Agent Hub API key or an OAuth 2.1 access token as a Bearer token.'
          );
        }
        return rpcResult(id, agentMessage(partsFromToolResult(result), contextId));
      }

      // Declared `streaming: false` / `pushNotifications: false` on the agent card, so these are
      // answered honestly rather than half-implemented. Every skill resolves inside the request,
      // which is also why there is no Task store and therefore no task to get, cancel or resubscribe.
      case 'message/stream':
      case 'tasks/resubscribe':
      case 'tasks/get':
      case 'tasks/cancel':
      case 'tasks/pushNotificationConfig/set':
      case 'tasks/pushNotificationConfig/get':
        return rpcError(
          id,
          ERR_UNSUPPORTED_OPERATION,
          `${method} is not supported: AbaPay skills complete synchronously, so message/send returns a final Message and no Task is created.`
        );

      default:
        return rpcError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err: any) {
    console.error('[A2A] request failed:', err?.message);
    return rpcError(id, ERR_INTERNAL, 'Internal error.');
  }
}

// A2A discovery is the agent card, not this endpoint — but a bare GET here is usually a scanner
// or a human pasting the URL, so point them at the card rather than returning a bare 405.
export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';
  return NextResponse.json({
    name: 'AbaPay',
    protocol: 'a2a',
    protocolVersion: '0.3.0',
    transport: 'JSONRPC',
    agentCard: `${appUrl}/.well-known/agent-card.json`,
    skills: (TOOLS as any[]).map((t) => t.name),
    hint: 'POST JSON-RPC 2.0 here. Supported method: message/send.',
  });
}
