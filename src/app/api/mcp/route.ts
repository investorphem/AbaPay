import 'server-only';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getServiceRules, checkServiceAllowed, checkAgentSpendAllowed } from '@/lib/serviceRules';
import { describeCapabilities, capabilityForIntent, getCapability } from '@/lib/deai/capabilities';
import { resolveServiceId, fetchCryptoBalances, verifyAccount } from '@/lib/deai/services';
import { getRemainingAllowance } from '@/lib/deai/relayer';
import { checkAccountNumber, checkAmount as checkAmountParity } from '@/lib/parity';
import { checkAutonomousCapacity, executeAgentPayment, type BatchItem } from '@/lib/deai/batch';
import { resolveMcpIdentity } from '@/lib/deai/mcpAuth';
import { checkPinAllowed, recordPinFailure, clearPinFailures, notifySpendOutOfBand } from '@/lib/deai/pinSecurity';
import { verifyPin } from '@/utils/pinSecurity';

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

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'abapay', version: '1.0.0' };

const SERVICE_INTENT: Record<string, string> = {
  AIRTIME: 'VEND_AIRTIME',
  DATA: 'VEND_DATA',
  ELECTRICITY: 'ELECTRICITY',
  CABLE: 'TV',
};

function stripMd(s: string): string {
  return String(s || '').replace(/[*_`]/g, '');
}

function textResult(text: string) {
  return { content: [{ type: 'text', text: stripMd(text) }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text', text: stripMd(text) }], isError: true };
}

const TOOLS = [
  {
    name: 'describe_capabilities',
    title: 'Describe Capabilities',
    description: 'List what AbaPay can pay (airtime, data, electricity, cable, etc.), any services currently paused, and example requests. Call this first if unsure what is supported.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // Static text, no wallet/network access, safe to call repeatedly.
    annotations: { title: 'Describe Capabilities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'check_balance',
    title: 'Check Balance',
    description: "Check a linked wallet's stablecoin balances and remaining agent spending allowance. Requires the api_key created in the AbaPay app's Agent Hub (MCP).",
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key (starts with aba_mcp_)' },
        chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Defaults to the chain approved when the key was created.' },
      },
      required: ['api_key'],
      additionalProperties: false,
    },
    // Reads on-chain state — never writes, never spends.
    annotations: { title: 'Check Balance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'pay_bill',
    title: 'Pay Bill',
    description: 'Pay a real Nigerian bill (airtime, data, electricity, or cable TV) from the linked wallet, settled on-chain and delivered via the same pipeline as the AbaPay app. Requires the api_key and the PIN set when the key was created. Money moves for real — only call this once the human has clearly confirmed the exact amount, provider, and account.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key' },
        pin: { type: 'string', description: '4-6 digit PIN set when the API key was created' },
        service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE'], description: 'Which kind of bill' },
        provider: { type: 'string', description: 'e.g. mtn, airtel, glo, ikeja-electric, dstv, gotv, startimes' },
        account_number: { type: 'string', description: 'Phone number (airtime/data), meter number (electricity), or smartcard/IUC number (cable)' },
        amount_ngn: { type: 'number', description: 'Amount in Naira' },
        variation_code: { type: 'string', description: 'Plan/bundle code — required for DATA, and for CABLE when changing package (not needed to renew the current one)' },
        meter_type: { type: 'string', enum: ['prepaid', 'postpaid'], description: 'Required for ELECTRICITY' },
        customer_name: { type: 'string', description: 'Optional — used for the receipt if known' },
        customer_email: { type: 'string', description: 'Optional — receipt is sent here if provided' },
      },
      required: ['api_key', 'pin', 'service', 'provider', 'account_number', 'amount_ngn'],
      additionalProperties: false,
    },
    // Moves real money on-chain — irreversible, and calling it twice pays twice.
    annotations: { title: 'Pay Bill', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

async function callDescribeCapabilities() {
  return textResult(await describeCapabilities());
}

async function callCheckBalance(args: any) {
  const apiKey = String(args?.api_key || '');
  if (!apiKey) return errorResult('api_key is required.');

  const identity = await resolveMcpIdentity(apiKey);
  if (!identity) return errorResult('Invalid or revoked API key. Create a new one in the AbaPay app under Agent Hub → MCP.');

  const chain = args?.chain === 'BASE' || args?.chain === 'CELO' ? args.chain : identity.approved_chain || 'CELO';
  const [balances, allowance] = await Promise.all([
    fetchCryptoBalances(identity.wallet_address, chain),
    getRemainingAllowance(identity.wallet_address, identity.approved_token || 'USD₮', chain),
  ]);

  const lines = [
    `Wallet: ${identity.wallet_address}`,
    `Chain: ${chain}`,
    '',
    'Balances:',
    ...Object.entries(balances).map(([sym, amt]) => `  ${sym}: ${amt}`),
    '',
    `Agent spending allowance (${identity.approved_token || 'USD₮'}): ${allowance.ok ? allowance.remaining.toFixed(4) : 'unavailable'}`,
  ];
  return textResult(lines.join('\n'));
}

async function callPayBill(args: any) {
  const apiKey = String(args?.api_key || '');
  const pin = String(args?.pin || '');
  const service = String(args?.service || '').toUpperCase();
  const provider = String(args?.provider || '').toLowerCase().trim();
  const accountNumber = String(args?.account_number || '').trim();
  const amountNgn = Number(args?.amount_ngn);
  const variationCode = args?.variation_code ? String(args.variation_code) : null;
  const meterType = args?.meter_type ? String(args.meter_type) : null;
  const customerName = args?.customer_name ? String(args.customer_name) : null;
  const customerEmail = args?.customer_email ? String(args.customer_email) : null;

  if (!apiKey) return errorResult('api_key is required.');
  if (!/^\d{4,6}$/.test(pin)) return errorResult('pin must be 4-6 digits.');
  const intent = SERVICE_INTENT[service];
  if (!intent) return errorResult('service must be one of AIRTIME, DATA, ELECTRICITY, CABLE.');
  if (!provider) return errorResult('provider is required — e.g. mtn, ikeja-electric, dstv.');
  if (!accountNumber) return errorResult('account_number is required.');
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) return errorResult('amount_ngn must be a positive number.');

  // 🔐 Same identity + PIN gate as every other channel — see src/lib/deai/pinSecurity.ts.
  // The counter lives on the agent_links row itself, so it survives across separate MCP
  // calls exactly the way it survives "Cancel"/"Start" on the chat channels.
  const identity = await resolveMcpIdentity(apiKey);
  if (!identity) return errorResult('Invalid or revoked API key. Create a new one in the AbaPay app under Agent Hub → MCP.');

  const pinGate = await checkPinAllowed(identity.id);
  if (!pinGate.allowed) return errorResult(pinGate.message || 'Locked — too many incorrect PINs.');

  if (!verifyPin(pin, identity.pin_hash)) {
    const fail = await recordPinFailure(identity.id, identity.wallet_address, 'MCP');
    return errorResult(fail.message || 'Incorrect PIN.');
  }
  await clearPinFailures(identity.id);

  // 🔴 RULE GATE — an operator-disabled service must be refused here exactly as it would be
  // in chat or the web app; the agent is a client like any other.
  const gate = await checkServiceAllowed(intent);
  if (!gate.allowed) return errorResult(gate.reason || 'This service is temporarily unavailable.');

  const serviceID = resolveServiceId(intent, provider);
  if (!serviceID) return errorResult(`Unknown provider "${provider}" for ${service}.`);

  const accCheck = checkAccountNumber(intent, accountNumber, provider);
  if (!accCheck.valid) return errorResult(accCheck.error || 'Invalid account number.');

  const amtCheck = checkAmountParity(intent, amountNgn, { isFixedPlan: !!variationCode });
  if (!amtCheck.valid) return errorResult(amtCheck.error || 'Invalid amount.');

  // ⚡ OPERATOR GATE — per-tx / per-day caps and the master agent kill switch.
  const spendGate = await checkAgentSpendAllowed(supabaseAdmin, identity.wallet_address, amountNgn);
  if (!spendGate.allowed) return errorResult(spendGate.reason || 'Agent spending is currently disabled for this account.');

  // Electricity/cable need a merchant-verify pass first — this is where a wrong meter or
  // smartcard number gets caught BEFORE money moves, same as the web app and chat.
  let resolvedCustomerName = customerName;
  const capability = capabilityForIntent(intent);
  const spec = capability ? getCapability(capability) : undefined;
  if (spec?.needsVerification) {
    const va = await verifyAccount(serviceID, accountNumber, meterType || undefined);
    if (!va.success) return errorResult(va.message || 'Could not verify that account.');
    resolvedCustomerName = va.customer_name || resolvedCustomerName;
  }

  const rules = await getServiceRules();
  const rate = rules.exchangeRate;
  const chain = identity.approved_chain || 'CELO';
  const tokenSymbol = identity.approved_token || 'USD₮';

  // The allowance is enforced BY THE CONTRACT regardless — checked here first so a shortfall
  // fails with a clear message instead of a wasted on-chain revert.
  const capacity = await checkAutonomousCapacity(identity.wallet_address, chain, tokenSymbol, amountNgn, rate);
  if (!capacity.ok) return errorResult(capacity.reason);

  const item: BatchItem = {
    serviceCategory: service,
    serviceID,
    provider,
    billersCode: accountNumber,
    amountNgn,
    meterType: meterType || undefined,
    chain,
    tokenSymbol,
  };

  const result = await executeAgentPayment({
    userWallet: identity.wallet_address,
    item,
    exchangeRate: rate,
    sourceChannel: 'MCP',
    email: customerEmail,
    customerName: resolvedCustomerName,
    variationCode,
  });

  // 🔒 OUT-OF-BAND SPEND ALERT — the real defence if this API key leaks: the owner is told
  // by email and on every other linked channel the instant money moves, regardless of vend
  // outcome. Figures are the pre-discount estimate from the capacity check above (the exact
  // amount is on the transaction row); good enough for a "was this you?" alert.
  if (result.success || result.vendFailed || result.pending) {
    try {
      await notifySpendOutOfBand(identity.wallet_address, {
        amountNgn,
        amountCrypto: capacity.neededCrypto.toFixed(6),
        token: tokenSymbol,
        service: `${provider} ${service}`,
        account: accountNumber,
        channel: 'MCP',
        txHash: result.txHash || '',
        remaining: Math.max(0, capacity.allowanceRemaining - capacity.neededCrypto).toFixed(4),
      });
    } catch { /* never block a result on alerting */ }
  }

  if (!result.success && !result.pending) return errorResult(result.message);
  return textResult(`${result.message}${result.txHash ? `\nTx: ${result.txHash}` : ''}`);
}

async function callTool(name: string, args: any) {
  switch (name) {
    case 'describe_capabilities': return callDescribeCapabilities();
    case 'check_balance': return callCheckBalance(args);
    case 'pay_bill': return callPayBill(args);
    default: return null;
  }
}

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'mcp', 60, 60);
  if (limited) return limited;

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
          instructions: 'AbaPay: check a linked wallet\'s stablecoin balance or pay a real Nigerian bill (airtime, data, electricity, cable), settled on-chain. Call describe_capabilities first. pay_bill and check_balance require an api_key created in the AbaPay app under Agent Hub -> MCP; pay_bill also requires the PIN set at that time.',
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
        const result = await callTool(toolName, params?.arguments || {});
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
