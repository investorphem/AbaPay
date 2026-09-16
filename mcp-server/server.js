#!/usr/bin/env node
// ⚡ A STANDALONE, SECRET-FREE MCP GATEWAY — scoped to exactly the agentic surface, not the
// consumer app. This exists because Glama's automated Dockerfile-based server check needs
// something it can build and boot to answer `tools/list`, and the real /api/mcp route lives
// inside the full Next.js consumer app (Supabase, VTpass, RPC, session secrets — none of
// which belong in a third-party build service). The tool CATALOG (name/description/
// inputSchema) is static data with zero database dependency, so it's served directly, no
// network call, no secret, no build step beyond `node server.js`. `tools/call` is the one
// thing that genuinely needs the real backend — that's proxied straight through to
// production over HTTPS, so this stays a real, working MCP server, not a stub that only
// pretends to answer `tools/list`.
//
// TWO TRANSPORTS, ONE HANDLER. `node server.js` (no args) binds an HTTP port — the shape
// documented in this package's README and used for local smoke-testing. `node server.js
// --stdio` instead speaks newline-delimited JSON-RPC over stdin/stdout — the shape
// mcp-proxy's `-- <command>` wrapping expects (see "What is mcp-proxy?" on Glama's Dockerfile
// admin page: it spawns a stdio MCP server and exposes it over SSE/HTTP itself). Both call
// the exact same handleMessage() below, so there is exactly one place tools/list and
// tools/call are actually implemented.
//
// Zero npm dependencies, deliberately — Node's built-in `http`, `https`, and `readline` are
// enough for a JSON-RPC relay this small, and it keeps the Dockerfile below to two lines with
// no install step at all.

const http = require('http');
const https = require('https');
const readline = require('readline');

const PROD_MCP_URL = 'https://agents.abapays.com/api/mcp';
const PORT = process.env.PORT || 8080;

// ⚡ Copied from src/app/agents/toolSchemas.ts's real shape (itself copied verbatim from
// src/lib/deai/mcpTools.ts's actual TOOLS array) — kept as plain MCP inputSchema JSON here
// rather than importing the Next.js app's TypeScript module, since this package intentionally
// has no dependency on that app at all. See docs.abapays.com or /agents/mcp for the same
// catalog with full prose descriptions; this is the wire-format version a client consumes.
// Chain/token enums mirror what production actually accepts — CELO and BASE both, USD₮/USDC/
// USA₮ on Celo (USDC-only on Base) — not the Celo-only framing of the agent handbook, which
// describes the newer x402/A2A rails specifically, not this tool catalog.
const TOOLS = [
  { name: 'describe_capabilities', title: 'Describe Capabilities', description: 'List what AbaPay can pay (airtime, data, electricity, cable, etc.), any services currently paused, and example requests. Call this first if unsure what is supported.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'check_balance', title: 'Check Balance', description: "Check a linked wallet's stablecoin balances and remaining agent spending allowance. Works with no arguments once authorized via OAuth; otherwise pass the api_key.", inputSchema: { type: 'object', properties: { api_key: { type: 'string', description: 'AbaPay MCP API key (starts with aba_mcp_). Not needed over OAuth.' }, chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Defaults to the chain approved when the key was created.' } }, required: [], additionalProperties: false } },
  { name: 'list_plans', title: 'List Plans', description: 'List the REAL, currently purchasable plans for DATA, CABLE, or EDUCATION — exact codes and current prices. Always call before pay_bill for these three services.', inputSchema: { type: 'object', properties: { service: { type: 'string', enum: ['DATA', 'CABLE', 'EDUCATION'] }, provider: { type: 'string' } }, required: ['service', 'provider'], additionalProperties: false } },
  { name: 'list_international_options', title: 'List International Options', description: 'Browse the live international top-up catalogue (140+ countries) one level at a time: country → product type → operator → priced plan.', inputSchema: { type: 'object', properties: { country: { type: 'string' }, product_type_id: { type: 'string' }, operator_id: { type: 'string' } }, required: [], additionalProperties: false } },
  { name: 'transaction_history', title: 'Transaction History', description: 'List recent real transactions for the linked wallet — service, provider, amount, status, tx hash. No PIN required.', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: [], additionalProperties: false } },
  { name: 'pay_bill', title: 'Pay Bill', description: 'Pay a real bill — Nigerian (airtime, data, electricity, cable, WAEC/JAMB) or international airtime/data — from the linked wallet, settled on-chain. Executes immediately; no delay parameter exists.', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, pin: { type: 'string' }, service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNATIONAL'] }, provider: { type: 'string' }, account_number: { type: 'string' }, amount_ngn: { type: 'number' }, chain: { type: 'string', enum: ['CELO', 'BASE'] }, token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'], description: "USD₮ and USA₮ are Celo-only; Base supports USDC only." }, variation_code: { type: 'string' }, meter_type: { type: 'string', enum: ['prepaid', 'postpaid'] }, customer_email: { type: 'string' }, country: { type: 'string' }, product_type_id: { type: 'string' }, operator_id: { type: 'string' } }, required: ['pin', 'service', 'account_number'], additionalProperties: false } },
  { name: 'schedule_bill', title: 'Schedule Bill', description: 'Set up a recurring or future one-off bill payment. Charges nothing when this runs — money only moves later, when the schedule fires and the allowance still covers it.', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, pin: { type: 'string' }, service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE'] }, provider: { type: 'string' }, account_number: { type: 'string' }, amount_ngn: { type: 'number' }, variation_code: { type: 'string' }, meter_type: { type: 'string', enum: ['prepaid', 'postpaid'] }, frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'once'] }, day_of_week: { type: 'number' }, day_of_month: { type: 'number' }, schedule_in_minutes: { type: 'number' }, chain: { type: 'string', enum: ['CELO', 'BASE'] }, token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'] }, customer_email: { type: 'string' } }, required: ['pin', 'service', 'account_number', 'amount_ngn', 'frequency'], additionalProperties: false } },
  { name: 'list_schedules', title: 'List Schedules', description: "List active recurring/one-off bill schedules for the linked wallet. No PIN required.", inputSchema: { type: 'object', properties: { api_key: { type: 'string' } }, required: [], additionalProperties: false } },
  { name: 'cancel_schedule', title: 'Cancel Schedule', description: "Cancel one or more active schedules. Pass id for exactly one, provider for all of that provider's, or neither to cancel everything.", inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, id: { type: 'string' }, provider: { type: 'string' } }, required: [], additionalProperties: false } },
  { name: 'pay_bill_batch', title: 'Pay Bill Batch', description: 'Pay airtime or data to 2-20 recipients in one call, one PIN for the whole batch. All-or-nothing on capacity.', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, pin: { type: 'string' }, recipients: { type: 'array', minItems: 2, maxItems: 20, items: { type: 'object', properties: { service: { type: 'string', enum: ['AIRTIME', 'DATA'] }, provider: { type: 'string' }, account_number: { type: 'string' }, amount_ngn: { type: 'number' }, variation_code: { type: 'string' }, chain: { type: 'string', enum: ['CELO', 'BASE'] }, token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'] } }, required: ['service', 'provider', 'account_number', 'amount_ngn'], additionalProperties: false } }, chain: { type: 'string', enum: ['CELO', 'BASE'] }, token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'] }, customer_email: { type: 'string' } }, required: ['pin', 'recipients'], additionalProperties: false } },
];

const SERVER_INFO = { name: 'abapay-mcp-gateway', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return { error: 'Non-JSON upstream response', raw: text.slice(0, 500) }; }
}

/** Proxy tools/call straight to the real production server — this gateway holds no
 * credentials and no business logic of its own, it just relays the JSON-RPC request.
 * Returns a Promise<responseBody> so both the HTTP and stdio transports can share it. */
function proxyToProduction(bodyStr) {
  return new Promise((resolve) => {
    const url = new URL(PROD_MCP_URL);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } },
      (prodRes) => {
        let chunks = '';
        prodRes.on('data', (c) => (chunks += c));
        prodRes.on('end', () => resolve(safeParse(chunks)));
      }
    );
    req.on('error', () => resolve(rpcError(null, -32000, 'Upstream (production AbaPay) unreachable.')));
    req.write(bodyStr);
    req.end();
  });
}

/** The one place initialize/tools/list/tools/call are actually implemented. `raw` is the
 * original request body string, needed only to relay tools/call verbatim upstream. */
async function handleMessage(msg, raw) {
  switch (msg.method) {
    case 'initialize':
      return rpcResult(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'tools/list':
      return rpcResult(msg.id, { tools: TOOLS });
    case 'tools/call':
      // The only method that touches real state — relayed to the real backend, which still
      // enforces every PIN check, allowance, and kill switch exactly as it does for any
      // other caller. This gateway adds no privilege of its own.
      return proxyToProduction(raw);
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function startHttp() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, server: SERVER_INFO });

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return sendJson(res, 200, rpcError(null, -32700, 'Parse error')); }
      sendJson(res, 200, await handleMessage(msg, body));
    });
  });

  server.listen(PORT, () => {
    console.log(`abapay-mcp-gateway listening on :${PORT} — tools/list served locally, tools/call proxied to ${PROD_MCP_URL}`);
  });
}

/** mcp-proxy (and any other stdio MCP client) spawns this process directly and speaks one
 * JSON-RPC message per line on stdin, expecting one JSON-RPC message per line back on
 * stdout — never anything else on stdout, which is why every log line here goes to stderr. */
function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n'); }
    const result = await handleMessage(msg, trimmed);
    process.stdout.write(JSON.stringify(result) + '\n');
  });
  console.error(`abapay-mcp-gateway (stdio) ready — tools/list served locally, tools/call proxied to ${PROD_MCP_URL}`);
}

if (process.argv.includes('--stdio')) {
  startStdio();
} else {
  startHttp();
}
