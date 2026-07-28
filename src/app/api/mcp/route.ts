import 'server-only';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getServiceRules, checkServiceAllowed, checkAgentSpendAllowed } from '@/lib/serviceRules';
import { describeCapabilities, capabilityForIntent, getCapability } from '@/lib/deai/capabilities';
import { resolveServiceId, fetchCryptoBalances, verifyAccount } from '@/lib/deai/services';
import { getRemainingAllowance } from '@/lib/deai/relayer';
import { SUPPORTED_TOKENS } from '@/constants';
import { checkAccountNumber, checkAmount as checkAmountParity, requiresVariation, requiresVerifiedName } from '@/lib/parity';
import { checkAutonomousCapacity, executeAgentPayment, type BatchItem } from '@/lib/deai/batch';
import { fetchVariations, variationServiceId } from '@/lib/deai/selection';
import { resolveMcpIdentity, type McpIdentity } from '@/lib/deai/mcpAuth';
import { validateAccessToken } from '@/lib/deai/mcpOAuth';
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

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';

// ⚡ OAUTH 2.1 — the credential problem this solves:
// The api_key/pin tool ARGUMENTS below work, but a brand-new Claude conversation remembers
// nothing, so the human had to retype their api_key every single time. With OAuth the client
// authorises ONCE in a browser (see /api/oauth/authorize) and presents a Bearer token
// automatically forever after.
//
// 🔴 WHAT OAUTH DOES NOT CHANGE: the PIN. It is still required on every single pay_bill call,
// exactly as before, exactly as on Telegram/WhatsApp. OAuth re-establishes the CONNECTION
// without retyping; it never authorises a spend. A Bearer token on its own can read a
// balance and nothing more.
//
// 🔴 WHY A REAL 401 MATTERS: an HTTP 401 carrying WWW-Authenticate with a `resource_metadata`
// pointer is the ONLY signal an MCP client uses to discover "this server supports OAuth" and
// offer the connect button. Returning the same condition as a soft in-band tool error (which
// is what happened before) is invisible to it — the client just sees a tool that answered.
// Hence exactly one case became a real 401: NO credential supplied at all. A WRONG api_key, a
// bad PIN, or a malformed argument stay in-band tool errors, because those are not "you need
// to authenticate", they are "you authenticated and got it wrong" / "you called it wrong" —
// turning those into 401s would make a client re-run the whole browser flow over a typo.
const WWW_AUTH_MISSING = `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;
const WWW_AUTH_INVALID = `Bearer error="invalid_token", error_description="The access token is invalid, expired, or revoked", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;

// Sentinel a tool returns when it has NO credential to work with at all — the POST handler
// turns this, and only this, into a genuine HTTP 401 (see above).
const NEEDS_AUTH = Symbol('mcp-needs-auth');

const SERVICE_INTENT: Record<string, string> = {
  AIRTIME: 'VEND_AIRTIME',
  DATA: 'VEND_DATA',
  ELECTRICITY: 'ELECTRICITY',
  CABLE: 'TV',
  // EDUCATION joins the list now that capabilities.ts marks it supportedInChat — MCP is meant
  // to be the same trust boundary reached over JSON-RPC, so it must not be narrower than chat.
  // Every rule it needs already exists and is shared: requiresVariation() forces a
  // variation_code, checkAccountNumber() enforces JAMB's >=10-char profile ID, and
  // requiresVerifiedName() decides that only JAMB merchant-verifies.
  EDUCATION: 'EDUCATION',
};

// 🔴 THE BUG THIS AVOIDS: a blanket `/[*_\`]/g` strip (an earlier version of this function)
// turned "api_key is required." into "apikey is required." — several reused messages here
// (e.g. src/lib/deai/pinSecurity.ts's lockout text) wrap a trailing sentence in WhatsApp-style
// `_italics_`, but our OWN error messages use underscores for snake_case field names
// (api_key, amount_ngn, account_number), and a bare global strip can't tell those apart.
// Markdown italics are word-boundary-delimited (space/newline/string-edge on both sides);
// snake_case underscores always sit between two letters. The lookbehind/lookahead below
// only matches the former, so "api_key" and friends pass through completely untouched.
function stripMd(s: string): string {
  return String(s || '')
    .replace(/(?<=^|\s)_([^_\n]+)_(?=$|[\s.,!?])/g, '$1')
    .replace(/[*`]/g, '');
}

function textResult(text: string) {
  return { content: [{ type: 'text', text: stripMd(text) }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text', text: stripMd(text) }], isError: true };
}

// Which stablecoins actually exist on a given chain — same source (SUPPORTED_TOKENS) every
// other channel already filters against, so this can never offer a token that doesn't exist
// there (e.g. USDm is Celo-only).
function tokensForChain(chain: string): string[] {
  const key = chain.toLowerCase();
  return (SUPPORTED_TOKENS as any[])
    .filter((t) => !t.supportedNetworks || t.supportedNetworks.includes(key))
    .map((t) => t.symbol);
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
    description: "Check a linked wallet's stablecoin balances and remaining agent spending allowance. Works with no arguments once this connector is authorized via OAuth; otherwise pass the api_key created in the AbaPay app's Agent Hub (MCP).",
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key (starts with aba_mcp_). NOT needed when the connector is authorized via OAuth — omit it entirely in that case; only supply it if this server asked you to authenticate and OAuth is unavailable.' },
        chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Defaults to the chain approved when the key was created.' },
      },
      required: [],
      additionalProperties: false,
    },
    // Reads on-chain state — never writes, never spends.
    annotations: { title: 'Check Balance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    // 🔴 THE BUG THIS FIXES: pay_bill has REQUIRED variation_code for DATA/EDUCATION (and CABLE
    // on a change) since commit 8d30836 — correctly, since VTpass rejects a vend with no real
    // plan code — but nothing ever gave a caller a way to discover what a real one IS. Caught
    // via genuine live usage: asked to buy ₦1,000 of MTN data, Claude had no source of truth
    // for actual plan codes/prices and started guessing plausible-sounding sizes ("100, 200MB…
    // For ₦1,000 you'd typically get something in the 500MB–1GB range") instead of showing the
    // real catalog — exactly the kind of thing chat has never done, because chat has had
    // fetchVariations()-backed menus this whole time. This is that same, already-proven
    // function, exposed as a tool so an agent has the same real data chat's user does.
    name: 'list_plans',
    title: 'List Plans',
    description: 'List the REAL, currently purchasable plans for a service that needs one — DATA bundles, CABLE packages, or EDUCATION products (WAEC/JAMB) — with their exact codes and current VTpass prices. ALWAYS call this before pay_bill for these three services and pass back one of the returned codes as variation_code. Never guess a plan, a code, or a price — if this returns nothing usable, say so rather than inventing one.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: ['DATA', 'CABLE', 'EDUCATION'], description: 'Which service to list plans for. Electricity and airtime are free-amount and have no plan list.' },
        provider: { type: 'string', description: 'e.g. mtn, airtel, glo, 9mobile (data); dstv, gotv, startimes (cable); waec, waec-registration, jamb (education)' },
      },
      required: ['service', 'provider'],
      additionalProperties: false,
    },
    // Read-only catalog lookup — no wallet, no auth, safe to call as often as needed.
    annotations: { title: 'List Plans', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'pay_bill',
    title: 'Pay Bill',
    description: 'Pay a real Nigerian bill (airtime, data, electricity, cable TV, or a WAEC/JAMB education PIN) from the linked wallet, settled on-chain and delivered via the same pipeline as the AbaPay app. For DATA, CABLE (when changing package), and EDUCATION, call list_plans first and use a real variation_code from it — never guess one. ALWAYS requires the PIN — including when this connector is authorized via OAuth; ask the human for it every time and never guess or reuse a remembered one. The api_key is only needed when OAuth is not in use. Money moves for real — only call this once the human has clearly confirmed the exact amount, provider, and account.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        pin: { type: 'string', description: '4-6 digit PIN set when the API key was created. Required on EVERY payment, including over an OAuth connection — ask the human for it each time.' },
        service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION'], description: 'Which kind of bill' },
        provider: { type: 'string', description: 'e.g. mtn, airtel, glo, ikeja-electric, dstv, gotv, startimes, waec, waec-registration, jamb' },
        // WAEC genuinely has no account of its own — the web app sends the buyer's phone as
        // the billers code (page.tsx: `payloadBillersCode = educationProvider === "jamb" ?
        // accountNumber : customerPhone`), so this one generic field covers both shapes as
        // long as the caller is told which value belongs here.
        account_number: { type: 'string', description: "Phone number (airtime/data), meter number (electricity), smartcard/IUC number (cable), JAMB profile ID (education: jamb), or the buyer's phone number (education: waec — WAEC has no separate account, the PIN is delivered to this number)" },
        amount_ngn: { type: 'number', description: 'Amount in Naira' },
        chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Defaults to the chain approved when the API key was created. Only override this if the default chain lacks balance/allowance and check_balance shows funds on the other one.' },
        token: { type: 'string', enum: ['USD₮', 'USDC', 'USDm'], description: 'Which stablecoin to pay with. Defaults to the token approved when the API key was created. If that one is short on balance or on-chain allowance, call check_balance first to see what else is available on this chain, then retry with this field set — e.g. if USD₮ is short but the wallet holds USDC with its own approved limit, pass token: "USDC".' },
        variation_code: { type: 'string', description: 'Plan/bundle/product code — required for DATA and EDUCATION (the exam product, e.g. the WAEC result-checker or the JAMB UTME PIN), and for CABLE when changing package (not needed to renew the current one)' },
        meter_type: { type: 'string', enum: ['prepaid', 'postpaid'], description: 'Required for ELECTRICITY' },
        customer_name: { type: 'string', description: 'Optional — used for the receipt if known' },
        customer_email: { type: 'string', description: 'Optional — receipt is sent here if provided' },
      },
      // `pin` stays required, deliberately and permanently — OAuth removes the retyping of
      // the api_key, never the per-payment PIN confirmation. `api_key` is no longer required
      // because a valid Bearer token supplies the identity instead; the runtime check below
      // enforces "one or the other" and returns a real 401 when there is neither.
      required: ['pin', 'service', 'provider', 'account_number', 'amount_ngn'],
      additionalProperties: false,
    },
    // Moves real money on-chain — irreversible, and calling it twice pays twice.
    annotations: { title: 'Pay Bill', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

async function callDescribeCapabilities() {
  return textResult(await describeCapabilities());
}

// No auth required — this is a read-only catalog lookup, same trust level as
// describe_capabilities. Shares fetchVariations()/variationServiceId() with chat
// (src/lib/deai/selection.ts) so the two can never see a different plan list or price.
async function callListPlans(args: any) {
  const service = String(args?.service || '').toUpperCase();
  const provider = String(args?.provider || '').toLowerCase().trim();
  if (!provider) return errorResult('provider is required.');

  const intent = SERVICE_INTENT[service];
  if (!intent || !['VEND_DATA', 'TV', 'EDUCATION'].includes(intent)) {
    return errorResult(`list_plans only applies to DATA, CABLE, or EDUCATION — "${service || '(missing)'}" has no plan list. Electricity and airtime are free-amount: just pass amount_ngn straight to pay_bill.`);
  }

  const serviceID = variationServiceId(intent, provider);
  const options = await fetchVariations(serviceID);

  if (options.length === 0) {
    return errorResult(`No plans came back for "${provider}" — either the provider name is wrong, or VTpass currently has nothing listed for it (this genuinely happens, e.g. JAMB isn't enabled on this account right now). Double-check the spelling, or tell the human this specific option isn't available rather than guessing a code.`);
  }

  const lines = options.map((o) => `• code: "${o.id}" — ${o.label}${o.price ? ` — ₦${o.price.toLocaleString()}` : ''}`);
  return textResult(`${options.length} real, currently purchasable plan(s) for ${provider} — pass the exact "code" shown as variation_code to pay_bill:\n\n${lines.join('\n')}`);
}

// Both credential routes converge here, and both produce the identical McpIdentity — so
// everything downstream (allowance, PIN gate, kill switches, spend alerts) is untouched by
// which one was used.
//
// PRECEDENCE: an explicitly-passed api_key WINS over the OAuth identity. A wallet may hold
// several MCP keys, and if a caller deliberately names one it must not be silently overridden
// by whichever identity the connector happens to be authorised as — that would be paying a
// bill from the wrong wallet, which is the worst possible failure here. Omitting api_key (the
// normal OAuth case) falls through to the token's identity.
async function resolveIdentity(
  args: any,
  oauthIdentity: McpIdentity | null
): Promise<{ identity: McpIdentity } | { error: 'missing' | 'invalid' }> {
  const apiKey = String(args?.api_key || '');
  if (apiKey) {
    const identity = await resolveMcpIdentity(apiKey);
    return identity ? { identity } : { error: 'invalid' };
  }
  if (oauthIdentity) return { identity: oauthIdentity };
  return { error: 'missing' };
}

const INVALID_KEY_MSG = 'Invalid or revoked API key. Create a new one in the AbaPay app under Agent Hub → MCP.';

async function callCheckBalance(args: any, oauthIdentity: McpIdentity | null) {
  const resolved = await resolveIdentity(args, oauthIdentity);
  if ('error' in resolved) {
    // No credential at all → real 401 so the client can offer the OAuth connect flow.
    // A wrong key → in-band error, exactly as before.
    if (resolved.error === 'missing') return NEEDS_AUTH;
    return errorResult(INVALID_KEY_MSG);
  }
  const identity = resolved.identity;

  const chain = args?.chain === 'BASE' || args?.chain === 'CELO' ? args.chain : identity.approved_chain || 'CELO';
  const tokens = tokensForChain(chain);
  const [balances, allowances] = await Promise.all([
    fetchCryptoBalances(identity.wallet_address, chain),
    Promise.all(tokens.map((sym) => getRemainingAllowance(identity.wallet_address, sym, chain))),
  ]);

  // Every token on this chain, not just the one the API key defaults to — pay_bill accepts a
  // token override (see its description), so the agent needs the full picture up front to
  // know a fallback is even worth trying, rather than discovering it only after a failure.
  const lines = [
    `Wallet: ${identity.wallet_address}`,
    `Chain: ${chain}`,
    `Default token for pay_bill (set when this API key was created): ${identity.approved_token || 'USD₮'}`,
    '',
    'Per-token balance and approved agent spending limit:',
    ...tokens.map((sym, i) => {
      const bal = balances[sym] ?? '0.0000';
      const a = allowances[i];
      const lim = a.ok ? a.remaining.toFixed(4) : 'unavailable';
      return `  ${sym}: balance ${bal}, approved limit ${lim}`;
    }),
  ];
  return textResult(lines.join('\n'));
}

async function callPayBill(args: any, oauthIdentity: McpIdentity | null) {
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
  const chainOverride = args?.chain === 'BASE' || args?.chain === 'CELO' ? args.chain : null;
  const tokenOverride = args?.token ? String(args.token) : null;

  // No credential of ANY kind → this is the "you need to authenticate" case, and the only
  // one that becomes a real HTTP 401. Checked before argument validation so a caller with no
  // credential is told to authenticate rather than being sent to fix an unrelated field.
  if (!apiKey && !oauthIdentity) return NEEDS_AUTH;
  // The PIN is required regardless of how identity was established — see the note on the
  // tool's `required` array. An OAuth connection does not, and will never, skip this.
  if (!/^\d{4,6}$/.test(pin)) return errorResult('pin must be 4-6 digits.');
  const intent = SERVICE_INTENT[service];
  if (!intent) {
    // BANK_TRANSFER is a real AbaPay capability that deliberately isn't agent-payable (see
    // capabilities.ts — supportedInChat: false). A bare "must be one of…" told a calling agent
    // nothing about WHY, so it had no way to give the human a useful answer beyond "not
    // supported"; it would either keep retrying or report it as missing. Driven off the
    // capability's OWN supportedInChat flag rather than a second hardcoded list here, so
    // flipping a capability in capabilities.ts is all it takes — that is exactly what
    // EDUCATION just did, and it needed no edit at this line.
    const appOnly = capabilityForIntent(service);
    const appOnlySpec = appOnly ? getCapability(appOnly) : undefined;
    if (appOnlySpec && !appOnlySpec.supportedInChat) {
      return errorResult(`${appOnlySpec.label} can't be paid through this API — ${appOnlySpec.notes || 'it must be completed in the AbaPay app.'} Tell the user to open ${process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com'}. pay_bill supports ${Object.keys(SERVICE_INTENT).join(', ')}.`);
    }
    return errorResult(`service must be one of ${Object.keys(SERVICE_INTENT).join(', ')}.`);
  }
  if (!provider) return errorResult('provider is required — e.g. mtn, ikeja-electric, dstv.');
  if (!accountNumber) return errorResult('account_number is required.');
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) return errorResult('amount_ngn must be a positive number.');

  // 🔴 THE BUG THIS FIXES: both of these were described as required in the tool's inputSchema
  // but NOTHING enforced them, and neither is recoverable once the money has moved. The chat
  // channel gates both (requiresVariation() blocks a data purchase until a plan is picked; the
  // AWAITING_METER_TYPE step blocks electricity until prepaid/postpaid is known) — MCP simply
  // skipped straight to settlement:
  //   • DATA with no variation_code: the on-chain payment settles, then VTpass is asked to
  //     vend a bundle that was never named — FAILED_VENDING and a refund round-trip, for a
  //     mistake that costs nothing to catch here.
  //   • ELECTRICITY with no meter_type: merchant-verify is called without a type and the vend
  //     goes out with no prepaid/postpaid at all.
  // Reuses parity.ts's requiresVariation — the same function the chat gate calls — rather
  // than a second copy of the rule that could drift away from it.
  if (requiresVariation(intent, provider) && !variationCode) {
    return errorResult(`variation_code is required for ${service} — it names the exact bundle/package to buy. Call describe_capabilities, or pick the plan in the AbaPay app, to get a valid code.`);
  }
  if (intent === 'ELECTRICITY' && meterType !== 'prepaid' && meterType !== 'postpaid') {
    return errorResult('meter_type is required for ELECTRICITY and must be exactly "prepaid" or "postpaid".');
  }

  // 🔐 Same identity + PIN gate as every other channel — see src/lib/deai/pinSecurity.ts.
  // The counter lives on the agent_links row itself, so it survives across separate MCP
  // calls exactly the way it survives "Cancel"/"Start" on the chat channels.
  const resolved = await resolveIdentity(args, oauthIdentity);
  if ('error' in resolved) {
    if (resolved.error === 'missing') return NEEDS_AUTH;
    return errorResult(INVALID_KEY_MSG);
  }
  const identity = resolved.identity;

  const pinGate = await checkPinAllowed(identity.id);
  if (!pinGate.allowed) return errorResult(pinGate.message || 'Locked — too many incorrect PINs.');

  if (!verifyPin(pin, identity.pin_hash)) {
    const fail = await recordPinFailure(identity.id, identity.wallet_address, 'MCP');
    return errorResult(fail.message || 'Incorrect PIN.');
  }
  await clearPinFailures(identity.id);

  // 🔴 RULE GATE — an operator-disabled service must be refused here exactly as it would be
  // in chat or the web app; the agent is a client like any other.
  const gate = await checkServiceAllowed(intent, provider);
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

  // Electricity/cable/JAMB need a merchant-verify pass first — this is where a wrong meter,
  // smartcard or profile ID gets caught BEFORE money moves, same as the web app and chat.
  //
  // 🔴 THE BUG THIS FIXES: this gated on the CAPABILITY's needsVerification flag, which is a
  // whole-capability yes/no and cannot express the per-provider rule the web app actually
  // enforces. Two providers get it wrong: showmax (cable, but has no smartcard to verify) and
  // now WAEC (education, but has no account at all — verifying its billers code, which is
  // just the buyer's phone, fails outright). parity.ts's requiresVerifiedName IS that rule,
  // it takes the provider, and it's the same function chat's verification gate calls.
  let resolvedCustomerName = customerName;
  if (requiresVerifiedName(intent, provider)) {
    // JAMB takes the chosen product as the verify `type`, exactly as the web app does
    // (page.tsx's verifyMerchant: serviceID "jamb", type = selectedEducationPlan
    // .variation_code); electricity takes prepaid/postpaid there instead.
    const verifyType = intent === 'EDUCATION' ? (variationCode || undefined) : (meterType || undefined);
    const va = await verifyAccount(serviceID, accountNumber, verifyType);
    if (!va.success) return errorResult(va.message || 'Could not verify that account.');
    resolvedCustomerName = va.customer_name || resolvedCustomerName;
  }

  const rules = await getServiceRules();
  const rate = rules.exchangeRate;
  const chain = chainOverride || identity.approved_chain || 'CELO';
  const chainTokens = tokensForChain(chain);
  // Defaults to whatever was approved when the API key was created — same as every other
  // channel — but callers can pass `token` to retry with a different one on the same chain
  // (e.g. after check_balance shows USD₮ is short but USDC has both balance and an approved
  // limit). Falls back to the default if an invalid/unsupported symbol is passed.
  const tokenSymbol = tokenOverride && chainTokens.includes(tokenOverride) ? tokenOverride : (identity.approved_token || 'USD₮');

  // The allowance is enforced BY THE CONTRACT regardless — checked here first so a shortfall
  // fails with a clear message instead of a wasted on-chain revert.
  const capacity = await checkAutonomousCapacity(identity.wallet_address, chain, tokenSymbol, amountNgn, rate);
  if (!capacity.ok) {
    // Don't just report the shortfall — check whether ANOTHER token on this same chain
    // already has both the balance and the approved allowance to cover it, and say so. This
    // is what actually lets a caller act on "use USDC instead" rather than hitting a dead end
    // that only names the one token that came up short.
    const otherTokens = chainTokens.filter((t) => t !== tokenSymbol);
    const otherChecks = await Promise.all(
      otherTokens.map((t) => checkAutonomousCapacity(identity.wallet_address, chain, t, amountNgn, rate))
    );
    const viable = otherTokens.find((_, i) => otherChecks[i].ok);
    if (viable) {
      return errorResult(`${capacity.reason}\n\nHowever, ${viable} on ${chain} already has enough balance and an approved agent limit to cover this. Retry pay_bill with token: "${viable}" to use it instead.`);
    }
    return errorResult(capacity.reason);
  }

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

// The OAuth identity is threaded through as a PARAMETER, never stashed in module scope — a
// serverless instance handles many requests and module state is shared between them, so a
// module-level "current identity" would be a wallet-mixing bug waiting for two concurrent
// users.
async function callTool(name: string, args: any, oauthIdentity: McpIdentity | null) {
  switch (name) {
    case 'describe_capabilities': return callDescribeCapabilities();
    case 'list_plans': return callListPlans(args);
    case 'check_balance': return callCheckBalance(args, oauthIdentity);
    case 'pay_bill': return callPayBill(args, oauthIdentity);
    default: return null;
  }
}

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
          instructions: "AbaPay: check a linked wallet's stablecoin balance or pay a real Nigerian bill (airtime, data, electricity, cable), settled on-chain. Call describe_capabilities first. For DATA, CABLE, or EDUCATION, call list_plans before pay_bill and use one of its real returned codes as variation_code — never guess a plan, code, or price. Authentication: OAuth 2.1 is supported and preferred — authorize once in the browser and this connection is remembered, so no api_key argument is ever needed again. The api_key created in the AbaPay app under Agent Hub -> MCP remains the fallback for clients that cannot do OAuth. Either way, pay_bill ALWAYS requires the PIN set when the key was created — OAuth does not remove it. Ask the human for their PIN on every single payment.",
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
