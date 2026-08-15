import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getServiceRules, checkServiceAllowed, checkAgentSpendAllowed, isChannelEnabled } from '@/lib/serviceRules';
import { describeCapabilities, capabilityForIntent, getCapability } from '@/lib/deai/capabilities';
import { resolveServiceId, fetchCryptoBalances, verifyAccount } from '@/lib/deai/services';
import { getRemainingAllowance } from '@/lib/deai/relayer';
import { LEGACY_RECORD_CHAIN, tokenSymbolsForChain } from '@/constants';
import { providersForIntent } from '@/lib/vtpassCatalog';
import { checkAccountNumber, checkAmountLive, requiresVariation, requiresVerifiedName } from '@/lib/parity';
import { checkAutonomousCapacity, executeAgentPayment, type BatchItem, type AgentPaymentResult } from '@/lib/deai/batch';
import { fetchVariations, variationServiceId } from '@/lib/deai/selection';
import { resolveMcpIdentity, type McpIdentity } from '@/lib/deai/mcpAuth';
import { validateAccessToken } from '@/lib/deai/mcpOAuth';
import { checkPinAllowed, recordPinFailure, clearPinFailures, notifySpendOutOfBand } from '@/lib/deai/pinSecurity';
import { verifyPin } from '@/utils/pinSecurity';
import { renderReceiptImage, renderHistoryStatementImage } from '@/lib/deai/receiptCard';
import { explorerBaseFor } from '@/lib/chain';
import { resolveCountry, fetchCountries, fetchProducts, fetchOperators, fetchIntlVariations } from '@/lib/deai/international';
import { checkIntlMinimum } from '@/lib/parity';

// ⚡ AGENT TOOL LAYER — the tools themselves (definitions + implementations), extracted from
// src/app/api/mcp/route.ts so more than one transport can reach them. It is deliberately
// transport-agnostic: nothing here knows about JSON-RPC framing, HTTP status codes, or which
// protocol asked. Two routes consume it:
//
//   • /api/mcp  — MCP Streamable HTTP (the original caller)
//   • /api/a2a  — A2A (Agent2Agent) JSON-RPC
//
// 🔴 WHY THIS IS A MOVE, NOT A REWRITE: these functions are the live payment path. They were
// relocated verbatim — same logic, same messages, same trust boundary. A2A does not get its
// own copy of the security model; it calls the SAME callTool(), so the PIN gate, escalating
// lockout, on-chain allowance ceiling, kill switches and operator spend caps apply identically
// no matter which protocol the agent speaks. Adding a transport must never widen what an agent
// is allowed to do — only change how it asks.

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'abapay', version: '1.0.0' };

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';

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
export const WWW_AUTH_MISSING = `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;
export const WWW_AUTH_INVALID = `Bearer error="invalid_token", error_description="The access token is invalid, expired, or revoked", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`;

// Sentinel a tool returns when it has NO credential to work with at all — the POST handler
// turns this, and only this, into a genuine HTTP 401 (see above).
export const NEEDS_AUTH = Symbol('mcp-needs-auth');

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
  // 🔴 THE GAP THIS FIXES: capabilities.ts has always marked INTERNATIONAL supportedInChat —
  // but chat itself only ever VALIDATES an international request (country/account/amount) and
  // then tells the user to finish it in the app (src/app/api/deai/core/route.ts's INTERNATIONAL
  // branch literally replies "Open AbaPay to pick the operator and confirm"). MCP had no entry
  // at all, so it couldn't even get that far. callPayBill's INTERNATIONAL branch below actually
  // completes the purchase end-to-end — country → product type → operator → real variation
  // (see list_international_options) → vend — making MCP the first agent surface that finishes
  // an international payment itself rather than redirecting to the app.
  INTERNATIONAL: 'INTERNATIONAL',
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

export function textResult(text: string) {
  return { content: [{ type: 'text', text: stripMd(text) }] };
}

export function errorResult(text: string) {
  return { content: [{ type: 'text', text: stripMd(text) }], isError: true };
}

// Image block first, text second — MCP clients that render inline images (Claude included)
// show the card as the visual lead-in, with the text underneath exactly like the screenshot
// this was modeled on. A client that only supports text content just ignores the image block.
function imageAndTextResult(pngBuffer: Buffer, text: string) {
  return {
    content: [
      { type: 'image', data: pngBuffer.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: stripMd(text) },
    ],
  };
}

// Which stablecoins exist on a given chain, in the same order the web app shows them —
// tokenSymbolsForChain in @/constants. This used to be a local copy of the filter (as did the
// chat agent's, the Agent Hub's and the Pay tab's), which is how four surfaces could end up
// disagreeing about which stablecoin a chain leads with.
const tokensForChain = tokenSymbolsForChain;

export const TOOLS = [
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
    // Same "never guess a code" principle as list_plans, but for international top-ups: VTpass's
    // catalogue is FOUR levels deep (country -> product type -> operator -> priced variation),
    // so this drills down one level per call depending on which args are supplied, rather than
    // needing four separate tools. Call with no args (or just `country`) to browse.
    name: 'list_international_options',
    title: 'List International Options',
    description: "Browse the REAL, live international top-up catalogue (170+ countries) one level at a time. Call with no country to see supported countries. Add country to see its product types. Add product_type_id to see operators. Add operator_id too to see real, currently purchasable plans with their exact codes, foreign-currency price, and NGN-equivalent cost. ALWAYS call this before pay_bill with service: INTERNATIONAL, and pass back the exact country/product_type_id/operator_id/variation_code shown — never guess any of them. Only plans marked fixed-price can be paid via pay_bill right now; flexible-amount plans must be completed in the AbaPay app.",
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name or ISO code, e.g. "Ghana" or "GH". Omit to list all supported countries.' },
        product_type_id: { type: 'string', description: 'A product_type_id returned for this country — e.g. which kind of top-up (airtime vs a data bundle). Omit to list the country\'s product types.' },
        operator_id: { type: 'string', description: 'An operator_id returned for this country + product_type_id — the network to top up. Omit to list operators.' },
      },
      required: [],
      additionalProperties: false,
    },
    // Read-only catalog lookup — no wallet, no auth, safe to call as often as needed.
    annotations: { title: 'List International Options', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    // 🔴 THE GAP THIS FILLS: the app's own History tab has always let a user browse past
    // transactions (src/components/HistoryTab.tsx, backed by the same `transactions` table),
    // but MCP had no equivalent — an agent could pay a bill and check a balance, but never
    // answer "what did I pay last week?" without the human opening the app. Same trust level
    // as check_balance: read-only, no PIN, works with the linked wallet's own records only.
    name: 'transaction_history',
    title: 'Transaction History',
    description: "List recent real transactions for the linked wallet — same data as the AbaPay app's History tab (service, provider, amount, status, tx hash). Read-only, no PIN required.",
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        limit: { type: 'number', description: 'How many recent transactions to return. Defaults to 10, max 25.' },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { title: 'Transaction History', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'pay_bill',
    title: 'Pay Bill',
    description: 'Pay a real bill — Nigerian (airtime, data, electricity, cable TV, a WAEC/JAMB education PIN) or international airtime/data across 170+ countries — from the linked wallet, settled on-chain and delivered via the same pipeline as the AbaPay app. For DATA, CABLE (when changing package), and EDUCATION, call list_plans first and use a real variation_code from it. For service: INTERNATIONAL, call list_international_options first and pass back its exact country/product_type_id/operator_id/variation_code — never guess any of these. ALWAYS requires the PIN — including when this connector is authorized via OAuth; ask the human for it every time and never guess or reuse a remembered one. The api_key is only needed when OAuth is not in use. Money moves for real — only call this once the human has clearly confirmed the exact amount, provider, and account. EXECUTES IMMEDIATELY, with no delay/schedule parameter of any kind — there is no way to queue this call for later on this connection. If the human asks to pay "in N minutes", "later today", "tomorrow", or any other future time, do NOT call this now: ask them to confirm they want it sent immediately instead, or tell them delayed/recurring automations can only be set up from the AbaPay app or by messaging the AbaPay agent on Telegram/WhatsApp/X — never silently pay right away when a delay was requested.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        pin: { type: 'string', description: '4-6 digit PIN set when the API key was created. Required on EVERY payment, including over an OAuth connection — ask the human for it each time.' },
        service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNATIONAL'], description: 'Which kind of bill' },
        // WAEC genuinely has no account of its own — the web app sends the buyer's phone as
        // the billers code (page.tsx: `payloadBillersCode = educationProvider === "jamb" ?
        // accountNumber : customerPhone`), so this one generic field covers both shapes as
        // long as the caller is told which value belongs here.
        provider: { type: 'string', description: 'e.g. mtn, airtel, glo, ikeja-electric, dstv, gotv, startimes, waec, waec-registration, jamb. Not used for service: INTERNATIONAL — use country/product_type_id/operator_id instead.' },
        account_number: { type: 'string', description: "Phone number (airtime/data), meter number (electricity), smartcard/IUC number (cable), JAMB profile ID (education: jamb), the buyer's phone number (education: waec), or the destination phone number abroad (international)" },
        amount_ngn: { type: 'number', description: 'Amount in Naira. Not needed for service: INTERNATIONAL — the NGN-equivalent is derived from the live plan you picked via list_international_options.' },
        chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Defaults to the chain approved when the API key was created. Only override this if the default chain lacks balance/allowance and check_balance shows funds on the other one.' },
        token: { type: 'string', enum: ['USD₮', 'USDC', 'USDm'], description: 'Which stablecoin to pay with. Defaults to the token approved when the API key was created. If that one is short on balance or on-chain allowance, call check_balance first to see what else is available on this chain, then retry with this field set — e.g. if USD₮ is short but the wallet holds USDC with its own approved limit, pass token: "USDC".' },
        variation_code: { type: 'string', description: 'Plan/bundle/product code — required for DATA, EDUCATION, and INTERNATIONAL, and for CABLE when changing package (not needed to renew the current one)' },
        meter_type: { type: 'string', enum: ['prepaid', 'postpaid'], description: 'Required for ELECTRICITY' },
        customer_name: { type: 'string', description: 'Optional — used for the receipt if known' },
        customer_email: { type: 'string', description: 'Required for service: INTERNATIONAL (the receipt goes here). Optional otherwise.' },
        country: { type: 'string', description: 'Required for service: INTERNATIONAL — country name or ISO code, from list_international_options.' },
        product_type_id: { type: 'string', description: 'Required for service: INTERNATIONAL — from list_international_options.' },
        operator_id: { type: 'string', description: 'Required for service: INTERNATIONAL — from list_international_options.' },
      },
      // `pin` stays required, deliberately and permanently — OAuth removes the retyping of
      // the api_key, never the per-payment PIN confirmation. `api_key` is no longer required
      // because a valid Bearer token supplies the identity instead; the runtime check below
      // enforces "one or the other" and returns a real 401 when there is neither. `provider` and
      // `amount_ngn` are conditionally required (not for INTERNATIONAL) — enforced in code per
      // branch rather than here, same treatment as `variation_code`/`meter_type` already get.
      required: ['pin', 'service', 'account_number'],
      additionalProperties: false,
    },
    // Moves real money on-chain — irreversible, and calling it twice pays twice.
    annotations: { title: 'Pay Bill', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

async function callDescribeCapabilities() {
  return textResult(await describeCapabilities('MCP'));
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

  const chain = args?.chain === 'BASE' || args?.chain === 'CELO' ? args.chain : identity.approved_chain || LEGACY_RECORD_CHAIN;
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

async function callTransactionHistory(args: any, oauthIdentity: McpIdentity | null) {
  const resolved = await resolveIdentity(args, oauthIdentity);
  if ('error' in resolved) {
    if (resolved.error === 'missing') return NEEDS_AUTH;
    return errorResult(INVALID_KEY_MSG);
  }
  const identity = resolved.identity;

  const limitRaw = Number(args?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 25) : 10;

  // Excludes preflight rows (never-broadcast intents, same convention as cleanupPreflights.ts)
  // — those aren't real transactions a user would recognize as "something I did".
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .ilike('wallet_address', identity.wallet_address)
    .not('tx_hash', 'like', 'preflight_%')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[MCP] transaction_history query failed:', error.message);
    return errorResult('Could not load transaction history right now — try again shortly.');
  }
  if (!data || data.length === 0) {
    return textResult('No transactions found for this wallet yet.');
  }

  const lines = data.map((tx: any, i: number) => {
    const date = new Date(tx.created_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const serviceLabel = `${(tx.network || '').toUpperCase()} ${tx.service_category || ''}`.trim();
    const amount = `₦${Number(tx.amount_naira || 0).toLocaleString()}`;
    const explorerLink = String(tx.tx_hash || '').startsWith('0x') ? ` — ${explorerBaseFor(tx.blockchain)}/tx/${tx.tx_hash}` : '';
    return `${i + 1}. ${date} — ${serviceLabel} — ${amount} — ${tx.status} — acct ${tx.account_number}${explorerLink}`;
  });

  const text = `${data.length} recent transaction(s) for ${identity.wallet_address}:\n\n${lines.join('\n')}`;

  try {
    const rows = data.map((tx: any) => ({
      date: new Date(tx.created_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      serviceLabel: `${(tx.network || '').toUpperCase()} ${tx.service_category || ''}`.trim(),
      accountNumber: tx.account_number || '',
      displayAmountNgn: `NGN ${Number(tx.amount_naira || 0).toLocaleString()}`,
      status: String(tx.status || ''),
    }));
    const png = await renderHistoryStatementImage(rows, identity.wallet_address);
    return imageAndTextResult(png, text);
  } catch (imgErr) {
    console.error('[MCP] Failed to render history image:', imgErr);
    return textResult(text);
  }
}

// No auth required — read-only catalogue lookup, same trust level as list_plans. Drills down
// one level of VTpass's country -> product type -> operator -> variation chain per call,
// depending on which args are already known.
async function callListInternationalOptions(args: any) {
  const countryInput = args?.country ? String(args.country).trim() : '';
  const productTypeId = args?.product_type_id ? String(args.product_type_id) : '';
  const operatorId = args?.operator_id ? String(args.operator_id) : '';

  if (!countryInput) {
    const countries = await fetchCountries();
    if (countries.length === 0) return errorResult('Could not load the international country list right now — try again shortly.');
    const lines = countries.map((c) => `• ${c.name} — code: "${c.code}"${c.currency ? ` (${c.currency})` : ''}`);
    return textResult(`${countries.length} supported countries — call again with one of these as country:\n\n${lines.join('\n')}`);
  }

  const country = await resolveCountry(countryInput);
  if (!country) {
    return errorResult(`"${countryInput}" isn't in our live international catalogue right now. Call list_international_options with no country to see what's supported.`);
  }

  if (!productTypeId) {
    const products = await fetchProducts(country.code);
    if (products.length === 0) return errorResult(`No product types came back for ${country.name} right now.`);
    const lines = products.map((p) => `• ${p.name} — product_type_id: "${p.product_type_id}"`);
    return textResult(`${products.length} product type(s) for ${country.name} — call again with country: "${country.code}" and one of these as product_type_id:\n\n${lines.join('\n')}`);
  }

  if (!operatorId) {
    const operators = await fetchOperators(country.code, productTypeId);
    if (operators.length === 0) return errorResult(`No operators came back for ${country.name} with that product type — double-check product_type_id.`);
    const lines = operators.map((o) => `• ${o.name} — operator_id: "${o.operator_id}"`);
    return textResult(`${operators.length} operator(s) for ${country.name} — call again with the same country/product_type_id and one of these as operator_id:\n\n${lines.join('\n')}`);
  }

  const variations = await fetchIntlVariations(operatorId, productTypeId);
  if (variations.length === 0) return errorResult('No plans came back for that operator — double-check operator_id and product_type_id.');

  const lines = variations.map((v) => {
    const isFixed = v.fixedPrice === 'Yes';
    const foreignAmount = Number(v.variation_amount);
    const chargedAmount = Number(v.charged_amount);
    const nairaEquivalent = chargedAmount > 0 ? chargedAmount : foreignAmount * Number(v.variation_rate || '1');
    const payability = isFixed ? '[fixed-price — payable via pay_bill]' : '[flexible amount — complete in the AbaPay app for now]';
    const priceText = isFixed && Number.isFinite(nairaEquivalent) && nairaEquivalent > 0
      ? ` — ${country.currency || ''} ${v.variation_amount} ≈ ₦${Math.round(nairaEquivalent).toLocaleString()}`
      : '';
    return `• ${v.name} — code: "${v.variation_code}"${priceText} ${payability}`;
  });

  return textResult(
    `${variations.length} plan(s) for this operator in ${country.name} — to pay_bill, pass service: "INTERNATIONAL", country: "${country.code}", product_type_id: "${productTypeId}", operator_id: "${operatorId}", and the exact code as variation_code:\n\n${lines.join('\n')}`
  );
}

// Shared tail end of pay_bill — the out-of-band spend alert plus the final response — used by
// both the domestic branch and the INTERNATIONAL branch so the two can't quietly drift apart.
//
// 🔴 SECURITY: the receipt page is PUBLIC (no auth — the whole point is that it's shareable),
// and a payment's tx_hash is visible to anyone watching the vault address on-chain. Keying the
// receipt URL by tx_hash would let anyone monitoring the blockchain correlate a public
// transaction to this page's contents — which, for electricity, includes the meter's verified
// customer NAME and ADDRESS. request_id is the same unguessable (36^12 keyspace, see
// getStrictRequestId in src/lib/vend.ts) lookup key this codebase already treats as the secure
// reference for sensitive per-transaction data, so it's what the shareable link uses instead.
async function finalizePayBillResult(params: {
  identity: McpIdentity;
  result: AgentPaymentResult;
  amountNgn: number;
  capacity: { neededCrypto: number; allowanceRemaining: number };
  tokenSymbol: string;
  serviceLabel: string;
  accountNumber: string;
  chain: string;
  customerName: string | null;
  customerAddress: string | null;
}) {
  const { identity, result, amountNgn, capacity, tokenSymbol, serviceLabel, accountNumber, chain, customerName, customerAddress } = params;

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
        service: serviceLabel,
        account: accountNumber,
        channel: 'MCP',
        txHash: result.txHash || '',
        remaining: Math.max(0, capacity.allowanceRemaining - capacity.neededCrypto).toFixed(4),
      });
    } catch { /* never block a result on alerting */ }
  }

  if (!result.success && !result.pending) return errorResult(result.message);

  const baseText = `${result.message}${result.txHash ? `\nTx: ${result.txHash}` : ''}`;

  // Only a genuinely completed, delivered payment gets the premium receipt card — a
  // pending/still-confirming result has no purchased_code/units yet, and a failed vend
  // already carries its own refund messaging in result.message. Never let a rendering
  // hiccup here hide a payment that actually succeeded — fall back to plain text.
  if (result.success && !result.vendFailed && !result.pending && result.txHash) {
    try {
      const { data: txRow } = await supabaseAdmin.from('transactions').select('*').eq('tx_hash', result.txHash).maybeSingle();
      const row = txRow as any;
      const receiptUrl = row?.request_id
        ? `${process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com'}/receipt/${row.request_id}`
        : null;
      const png = await renderReceiptImage({
        status: 'SUCCESS',
        serviceLabel,
        accountNumber,
        customerName: row?.customer_name || customerName || null,
        customerAddress: row?.customer_address || customerAddress || null,
        displayAmountNgn: `NGN ${amountNgn.toLocaleString()}`,
        cryptoCharged: `${Number(row?.amount_usdt ?? capacity.neededCrypto).toFixed(6)} ${tokenSymbol}`,
        purchasedCode: row?.purchased_code || null,
        units: row?.units || null,
        referenceId: row?.request_id || null,
        txHash: result.txHash,
        chain,
      });
      return imageAndTextResult(png, receiptUrl ? `${baseText}\nReceipt: ${receiptUrl}` : baseText);
    } catch (imgErr) {
      console.error('[MCP] Failed to render receipt image:', imgErr);
    }
  }

  return textResult(baseText);
}

// INTERNATIONAL branch of pay_bill — the identity is already resolved and the PIN already
// verified by the caller (callPayBill). Unlike chat's INTERNATIONAL handling (which only
// validates and then tells the user to finish in the app), this actually completes the
// purchase: country/operator/product-type/variation resolved against the LIVE VTpass catalogue,
// priced server-side from the variation's own rate (never a client-claimed amount), then run
// through the exact same allowance/spend/discount engine every other MCP payment uses.
async function callPayBillInternational(
  args: any,
  identity: McpIdentity,
  ctx: { accountNumber: string; customerName: string | null; customerEmail: string | null; chainOverride: string | null; tokenOverride: string | null }
) {
  const countryInput = args?.country ? String(args.country).trim() : '';
  const productTypeId = args?.product_type_id ? String(args.product_type_id) : '';
  const operatorId = args?.operator_id ? String(args.operator_id) : '';
  const variationCode = args?.variation_code ? String(args.variation_code) : '';
  const { accountNumber, customerName, customerEmail, chainOverride, tokenOverride } = ctx;

  if (!countryInput) return errorResult('country is required for service: INTERNATIONAL — call list_international_options first.');
  if (!productTypeId) return errorResult('product_type_id is required for service: INTERNATIONAL — call list_international_options first.');
  if (!operatorId) return errorResult('operator_id is required for service: INTERNATIONAL — call list_international_options first.');
  if (!variationCode) return errorResult('variation_code is required for service: INTERNATIONAL — call list_international_options first and pass back a real code.');
  // Same >=6 char rule the web app's international flow enforces (src/lib/parity.ts's
  // checkParity, isInternational branch).
  if (accountNumber.replace(/\s/g, '').length < 6) return errorResult('account_number looks too short — international top-ups need at least 6 characters.');
  // The frontend hard-requires a valid email for ALL international payments (parity.ts's
  // requiredFieldsFor) — the receipt is genuinely the only confirmation some of these deliver.
  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return errorResult('customer_email is required for service: INTERNATIONAL (your receipt is sent there) and must be a valid email address.');
  }

  const country = await resolveCountry(countryInput);
  if (!country) return errorResult(`"${countryInput}" isn't in our live international catalogue right now. Call list_international_options with no country to see what's supported.`);

  const gate = await checkServiceAllowed('INTERNATIONAL', null, { isInternational: true });
  if (!gate.allowed) return errorResult(gate.reason || 'International payments are temporarily unavailable.');

  // 🔴 NEVER TRUST A CLIENT-CLAIMED PRICE: re-fetch the live variation and derive the
  // NGN-equivalent ourselves, exactly like the web app does (variation_rate / charged_amount —
  // see international.ts) — this is what actually prices the on-chain crypto charge, so a stale
  // or fabricated amount would otherwise under/overcharge real money.
  const variations = await fetchIntlVariations(operatorId, productTypeId);
  const variation = variations.find((v) => v.variation_code === variationCode);
  if (!variation) return errorResult(`"${variationCode}" isn't a real plan for that operator/product type right now — call list_international_options again to get a current code.`);

  if (variation.fixedPrice !== 'Yes') {
    return errorResult(`"${variation.name}" is a flexible-amount plan — pay_bill only supports fixed-price international plans right now. Complete this one in the AbaPay app, or pick a fixed-price plan from list_international_options.`);
  }

  const foreignAmount = Number(variation.variation_amount);
  const variationRate = Number(variation.variation_rate || '1');
  const chargedAmount = Number(variation.charged_amount);
  const vendAmountNgn = chargedAmount > 0 ? chargedAmount : foreignAmount * variationRate;
  if (!Number.isFinite(vendAmountNgn) || vendAmountNgn <= 0) return errorResult('Could not price this plan right now — try again shortly.');

  const rules = await getServiceRules();
  const rate = rules.exchangeRate;

  // Same $1 floor the web app enforces for international (parity.ts's checkIntlMinimum).
  const intlMin = checkIntlMinimum(foreignAmount, variationRate, rate);
  if (!intlMin.valid) return errorResult(intlMin.error || 'That amount is too low.');

  const spendGate = await checkAgentSpendAllowed(supabaseAdmin, identity.wallet_address, vendAmountNgn);
  if (!spendGate.allowed) return errorResult(spendGate.reason || 'Agent spending is currently disabled for this account.');

  const chain = chainOverride || identity.approved_chain || LEGACY_RECORD_CHAIN;
  const chainTokens = tokensForChain(chain);
  const tokenSymbol = tokenOverride && chainTokens.includes(tokenOverride) ? tokenOverride : (identity.approved_token || 'USD₮');

  const capacity = await checkAutonomousCapacity(identity.wallet_address, chain, tokenSymbol, vendAmountNgn, rate);
  if (!capacity.ok) {
    const otherTokens = chainTokens.filter((t) => t !== tokenSymbol);
    const otherChecks = await Promise.all(otherTokens.map((t) => checkAutonomousCapacity(identity.wallet_address, chain, t, vendAmountNgn, rate)));
    const viable = otherTokens.find((_, i) => otherChecks[i].ok);
    if (viable) {
      return errorResult(`${capacity.reason}\n\nHowever, ${viable} on ${chain} already has enough balance and an approved agent limit to cover this. Retry pay_bill with token: "${viable}" to use it instead.`);
    }
    return errorResult(capacity.reason);
  }

  const displayAmount = `${country.currency || ''} ${foreignAmount.toLocaleString()}`.trim();

  const item: BatchItem = {
    serviceCategory: 'INTERNATIONAL',
    serviceID: 'foreign-airtime',
    provider: country.name,
    billersCode: accountNumber,
    amountNgn: vendAmountNgn,
    chain,
    tokenSymbol,
    isForeign: true,
    foreignAmount: variation.variation_amount,
    displayAmount,
    operatorId,
    countryCode: country.code,
    productTypeId,
  };

  const result = await executeAgentPayment({
    userWallet: identity.wallet_address,
    item,
    exchangeRate: rate,
    sourceChannel: 'MCP',
    email: customerEmail,
    customerName,
    variationCode,
  });

  return finalizePayBillResult({
    identity, result, amountNgn: vendAmountNgn, capacity, tokenSymbol,
    serviceLabel: `${country.name} INTERNATIONAL`,
    accountNumber, chain,
    customerName,
    customerAddress: null,
  });
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
  const isInternational = intent === 'INTERNATIONAL';
  if (!accountNumber) return errorResult('account_number is required.');

  // INTERNATIONAL doesn't use provider/amount_ngn/variation-via-requiresVariation/meter_type at
  // all — it has its own field set (country/product_type_id/operator_id/variation_code) and its
  // own amount source (the live plan's price, re-derived server-side — see
  // callPayBillInternational), validated inside its own branch below instead.
  if (!isInternational) {
    if (!provider) return errorResult('provider is required — e.g. mtn, ikeja-electric, dstv.');
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

  if (isInternational) {
    return callPayBillInternational(args, identity, {
      accountNumber, customerName, customerEmail, chainOverride, tokenOverride,
    });
  }

  // 🔴 RULE GATE — an operator-disabled service must be refused here exactly as it would be
  // in chat or the web app; the agent is a client like any other.
  const gate = await checkServiceAllowed(intent, provider);
  if (!gate.allowed) return errorResult(gate.reason || 'This service is temporarily unavailable.');

  const serviceID = resolveServiceId(intent, provider);
  if (!serviceID) return errorResult(`Unknown provider "${provider}" for ${service}.`);

  // 🔴 resolveServiceId is a pure STRING TRANSFORM — it appends "-data"/"-electric" and hands
  // anything else straight back. It has never checked that the result is a service VTpass
  // actually sells, so an agent passing provider:"showmax" or "jamb" got a confident
  // serviceID back, cleared every gate below, moved real money on-chain, and only THEN hit
  // {"code":"011","errors":"Service is Not Valid"} at vend time — leaving a paid-for
  // transaction to be refunded for a service that never existed. Now checked against the live
  // catalogue, before the on-chain spend, with the real alternatives in the error message.
  const validProviders = await providersForIntent(intent);
  if (validProviders.length > 0 && !validProviders.some(p => p.serviceID.toLowerCase() === serviceID.toLowerCase())) {
    return errorResult(
      `"${provider}" is not a ${service} provider AbaPay can currently sell. Available: ${validProviders.map(p => p.serviceID).join(', ')}.`
    );
  }

  const accCheck = checkAccountNumber(intent, accountNumber, provider);
  if (!accCheck.valid) return errorResult(accCheck.error || 'Invalid account number.');

  // Live per-provider ceiling — serviceID is already resolved above, so the MCP surface gets
  // the same real MTN-200k/Airtel-50k limits the web form and chat do, not a flat number.
  const amtCheck = await checkAmountLive(intent, amountNgn, { isFixedPlan: !!variationCode, provider: serviceID });
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
  // 🔴 THE BUG THIS FIXES: verifyAccount() returns customer_address too (VTpass's real
  // merchant-verify response for electricity meters) but this handler only ever read
  // customer_name off it — the address was verified and then silently thrown away, so
  // electricity receipts never carried the meter's registered name AND address the way the
  // web app's own merchant-verify flow does. executeAgentPayment/executeVend already accept
  // and store customerAddress; it just never reached them from here.
  let resolvedCustomerAddress: string | null = null;
  if (requiresVerifiedName(intent, provider)) {
    // JAMB takes the chosen product as the verify `type`, exactly as the web app does
    // (page.tsx's verifyMerchant: serviceID "jamb", type = selectedEducationPlan
    // .variation_code); electricity takes prepaid/postpaid there instead.
    const verifyType = intent === 'EDUCATION' ? (variationCode || undefined) : (meterType || undefined);
    const va = await verifyAccount(serviceID, accountNumber, verifyType);
    if (!va.success) return errorResult(va.message || 'Could not verify that account.');
    resolvedCustomerName = va.customer_name || resolvedCustomerName;
    resolvedCustomerAddress = va.customer_address || null;
  }

  const rules = await getServiceRules();
  const rate = rules.exchangeRate;
  const chain = chainOverride || identity.approved_chain || LEGACY_RECORD_CHAIN;
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
    customerAddress: resolvedCustomerAddress,
    variationCode,
  });

  return finalizePayBillResult({
    identity, result, amountNgn, capacity, tokenSymbol,
    serviceLabel: `${provider.toUpperCase()} ${service}`,
    accountNumber, chain,
    customerName: resolvedCustomerName,
    customerAddress: resolvedCustomerAddress,
  });
}

// The OAuth identity is threaded through as a PARAMETER, never stashed in module scope — a
// serverless instance handles many requests and module state is shared between them, so a
// module-level "current identity" would be a wallet-mixing bug waiting for two concurrent
// users.
export async function callTool(name: string, args: any, oauthIdentity: McpIdentity | null) {
  switch (name) {
    case 'describe_capabilities': return callDescribeCapabilities();
    case 'list_plans': return callListPlans(args);
    case 'list_international_options': return callListInternationalOptions(args);
    case 'check_balance': return callCheckBalance(args, oauthIdentity);
    case 'transaction_history': return callTransactionHistory(args, oauthIdentity);
    case 'pay_bill': return callPayBill(args, oauthIdentity);
    default: return null;
  }
}

