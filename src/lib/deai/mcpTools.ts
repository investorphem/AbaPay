import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { rateLimit } from '@/lib/rateLimit';
import { getServiceRules, checkServiceAllowed, checkAgentSpendAllowed } from '@/lib/serviceRules';
import { describeCapabilities, capabilityForIntent, getCapability } from '@/lib/deai/capabilities';
import { resolveServiceId, fetchCryptoBalances, verifyAccount } from '@/lib/deai/services';
import { getRemainingAllowance } from '@/lib/deai/relayer';
import { LEGACY_RECORD_CHAIN, tokenSymbolsForChain } from '@/constants';
import { providersForIntent } from '@/lib/vtpassCatalog';
import { checkAccountNumber, checkAmountLive, requiresVariation, requiresVerifiedName } from '@/lib/parity';
import { checkAutonomousCapacity, groupByChainToken, executeAgentPayment, type BatchItem, type AgentPaymentResult } from '@/lib/deai/batch';
import { fetchVariations, variationServiceId } from '@/lib/deai/selection';
import { resolveMcpIdentity, type McpIdentity } from '@/lib/deai/mcpAuth';
import { checkPinAllowed, recordPinFailure, clearPinFailures, notifySpendOutOfBand } from '@/lib/deai/pinSecurity';
import { verifyPin } from '@/utils/pinSecurity';
import { renderReceiptImage, renderHistoryStatementImage } from '@/lib/deai/receiptCard';
import { explorerBaseFor } from '@/lib/chain';
import { resolveCountry, fetchCountries, fetchProducts, fetchOperators, fetchIntlVariations } from '@/lib/deai/international';
import { checkIntlMinimum } from '@/lib/parity';
import { MCP_UI_CARD_URI } from '@/lib/deai/mcpUiTemplates';

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

// MCP Apps (SEP-1865) — attaches the data a host renders through the interactive card
// (mcpUiTemplates.ts) alongside whatever `content` (text ± PNG image) the result already had.
// `structuredContent` is a sibling of `content`, never a replacement for it: a host that
// hasn't negotiated the `io.modelcontextprotocol/ui` extension ignores this field entirely and
// falls back to `content` exactly as before — see the tool's own `_meta.ui` comment.
function withCard(result: { content: unknown[]; isError?: boolean }, structuredContent: Record<string, unknown>) {
  return { ...result, structuredContent };
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
    // See the identical note on transaction_history above.
    _meta: { ui: { resourceUri: MCP_UI_CARD_URI } },
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
    description: "List recent real transactions for the linked wallet — same data as the AbaPay app's History tab (service, provider, amount, status, tx hash). Read-only, no PIN required. The interactive card's own Next/Previous buttons page through results by re-calling this tool with a different offset — pass offset yourself only when asked for something like \"the next page\" or \"transactions before that\" in plain text.",
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        limit: { type: 'number', description: 'How many recent transactions to return. Defaults to 10, max 25.' },
        offset: { type: 'number', description: 'How many of the most recent transactions to skip before listing — 0 (default) starts at the newest. Used for paging: offset=10 with the default limit gets the next 10 after the first page.' },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { title: 'Transaction History', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    // MCP Apps (SEP-1865) — a host that negotiates io.modelcontextprotocol/ui renders this
    // tool's result as the interactive card (mcpUiTemplates.ts) instead of plain text; a host
    // that doesn't just ignores this field and gets the existing text + PNG image unchanged.
    _meta: { ui: { resourceUri: MCP_UI_CARD_URI } },
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
        token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'], description: 'Which stablecoin to pay with. Defaults to the token approved when the API key was created. If that one is short on balance or on-chain allowance, call check_balance first to see what else is available on this chain, then retry with this field set — e.g. if USD₮ is short but the wallet holds USDC with its own approved limit, pass token: "USDC".' },
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
    // See the identical note on transaction_history above.
    _meta: { ui: { resourceUri: MCP_UI_CARD_URI } },
  },
  {
    // 🔴 THE GAP THIS FILLS: Telegram/WhatsApp/X (src/app/api/deai/core/route.ts) have long
    // supported recurring/one-off scheduled bills (SCHEDULE_BILL, backed by the scheduled_bills
    // table and src/lib/scheduler.ts's cron runner) — MCP had no equivalent at all, so an agent
    // could pay a bill immediately but never set one up to run later. This collects in one call
    // what chat gathers over a multi-turn conversation (an MCP tool call is stateless), reusing
    // the exact same validation, PIN gate, and allowance/balance arithmetic pay_bill and chat's
    // buildScheduleConfirm already use — see callScheduleBill below.
    name: 'schedule_bill',
    title: 'Schedule Bill',
    description: 'Set up a recurring or future one-off bill payment — daily/weekly/monthly airtime, data, electricity, or cable — the same automation Telegram/WhatsApp/X support. Validates exactly like pay_bill (call list_plans first for DATA, or CABLE when changing package, to get a real variation_code) and ALWAYS requires the PIN, since this creates a standing spend. Nothing is charged when this tool runs — money only moves later, when the schedule actually fires, and only if the wallet still has a funded on-chain allowance at that time. If the approved agent limit already covers the amount right now, the schedule is created to auto-pay itself each time it is due; otherwise it is saved as notify-only and someone must call pay_bill manually when it comes due — the response says which. EDUCATION and INTERNATIONAL cannot be scheduled; pay those directly with pay_bill. Use list_schedules to see what is set up and cancel_schedule to remove one.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        pin: { type: 'string', description: '4-6 digit PIN set when the API key was created. Required to create a schedule, same as pay_bill.' },
        service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE'], description: 'Which kind of bill to schedule. EDUCATION and INTERNATIONAL are not schedulable — use pay_bill directly for those.' },
        provider: { type: 'string', description: 'e.g. mtn, airtel, glo, 9mobile, ikeja-electric, dstv, gotv, startimes' },
        account_number: { type: 'string', description: 'Phone number (airtime/data), meter number (electricity), or smartcard/IUC number (cable)' },
        amount_ngn: { type: 'number', description: 'Amount in Naira to charge each time the schedule runs.' },
        variation_code: { type: 'string', description: 'Plan/bundle/product code — required for DATA, and for CABLE when changing package (not needed to renew the current one). Get a real one from list_plans first.' },
        meter_type: { type: 'string', enum: ['prepaid', 'postpaid'], description: 'Required for ELECTRICITY' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'once'], description: 'How often this runs. "once" fires exactly one time, schedule_in_minutes from now.' },
        day_of_week: { type: 'number', description: 'Required when frequency is "weekly" — 0 (Sunday) through 6 (Saturday).' },
        day_of_month: { type: 'number', description: 'Required when frequency is "monthly" — 1 through 28.' },
        schedule_in_minutes: { type: 'number', description: 'Required when frequency is "once" — minutes from now to run it a single time.' },
        chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Defaults to the chain approved when the API key was created.' },
        token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'], description: 'Defaults to the token approved when the API key was created.' },
        customer_email: { type: 'string', description: "Where to send a notification when this runs. MCP has no persistent channel to message back into a conversation — without this, you'll need to poll list_schedules or transaction_history yourself to see what happened." },
      },
      required: ['pin', 'service', 'account_number', 'amount_ngn', 'frequency'],
      additionalProperties: false,
    },
    // Creates a standing future spend, but charges nothing itself and can be undone with
    // cancel_schedule — not destructive/irreversible the way pay_bill is.
    annotations: { title: 'Schedule Bill', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'list_schedules',
    title: 'List Schedules',
    description: 'List active recurring/one-off bill schedules for the linked wallet — same data as the AbaPay app and Telegram/WhatsApp "show my schedules". Read-only, no PIN required. Returns each schedule\'s id — pass that to cancel_schedule to remove one.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { title: 'List Schedules', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    // See the identical note on transaction_history above. Each row's Cancel button in the
    // card calls cancel_schedule directly (an app-visible tool that needs no PIN, same as
    // calling it from chat) — never pay_bill/schedule_bill, which stay text-only; see the
    // "no PIN entry inside the card" note on cancel_schedule's own _meta below.
    _meta: { ui: { resourceUri: MCP_UI_CARD_URI } },
  },
  {
    name: 'cancel_schedule',
    title: 'Cancel Schedule',
    description: 'Cancel one or more active schedules for the linked wallet. Call list_schedules first to get a real id. Pass id to cancel exactly one; pass provider to cancel every active schedule for that provider; omit both to cancel ALL active schedules for this wallet. No PIN required, matching chat.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        id: { type: 'string', description: 'The exact schedule id from list_schedules. Cancels only that one schedule.' },
        provider: { type: 'string', description: 'Cancel every active schedule for this provider, e.g. "mtn". Ignored if id is also given.' },
      },
      required: [],
      additionalProperties: false,
    },
    // Deactivates rows rather than moving money, and cancelling an already-cancelled schedule
    // is a no-op — reversible in spirit (a new schedule_bill call recreates it) and idempotent.
    annotations: { title: 'Cancel Schedule', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    // 🔴 THE GAP THIS FILLS: chat's intent engine has supported multiple recipients in one
    // message since intentEngine.ts's rule 14 ("send 500 to X and 1000 to Y") — MCP's pay_bill
    // only ever took one recipient per call. Structured tool calls don't need free-text
    // parsing to name several recipients at once, so this is a straight capability add, not a
    // reimplementation: it reuses the exact same grouping/capacity/execution primitives
    // (groupByChainToken, checkAutonomousCapacity, executeAgentPayment) core/route.ts's own
    // batch handler calls. One difference makes MCP MORE capable here, not just at parity:
    // chat's ParsedRecipient shape (intentEngine.ts) has no per-recipient variation_code field,
    // so a chat-driven DATA batch has no way to name each recipient's plan — a structured tool
    // call can, so this one requires it per DATA recipient instead of inheriting that gap.
    name: 'pay_bill_batch',
    title: 'Pay Bill Batch',
    description: 'Pay airtime or data to multiple recipients in ONE call — the same multi-recipient batch Telegram/WhatsApp/X support ("send 500 to X and 1000 to Y"). One PIN authorizes the whole batch. Recipients are grouped by (chain, token); each group\'s capacity (balance + approved agent limit) is checked against that group\'s own subtotal — but if ANY group is short, the ENTIRE batch is refused before anything moves (all-or-nothing on capacity; paying 6 of 8 recipients because the 7th was under-funded is worse than one clear error up front). Once capacity clears, recipients are paid one at a time and the response reports each individually, since a single vend failure partway through must not be reported as if the whole batch failed. AIRTIME and DATA only — electricity, cable, education, and international are not batchable; call pay_bill for those, one at a time. For DATA, call list_plans first and give each recipient needing one its own real variation_code. EXECUTES IMMEDIATELY: no delay/schedule option, same as pay_bill — for a delayed/recurring batch, call schedule_bill once per recipient instead.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'AbaPay MCP API key. NOT needed when the connector is authorized via OAuth — omit it entirely in that case.' },
        pin: { type: 'string', description: '4-6 digit PIN set when the API key was created. Required once for the whole batch.' },
        recipients: {
          type: 'array',
          minItems: 2,
          maxItems: 20,
          description: 'At least 2 recipients (a single recipient should just use pay_bill), at most 20 per call — split a larger batch across several calls.',
          items: {
            type: 'object',
            properties: {
              service: { type: 'string', enum: ['AIRTIME', 'DATA'], description: 'Only AIRTIME and DATA are batchable.' },
              provider: { type: 'string', description: 'e.g. mtn, airtel, glo, 9mobile' },
              account_number: { type: 'string', description: 'Phone number to top up' },
              amount_ngn: { type: 'number', description: 'Amount in Naira for this recipient' },
              variation_code: { type: 'string', description: 'Required for DATA — call list_plans first and pass a real code for this recipient\'s plan.' },
              chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Overrides the batch-level chain for this recipient only.' },
              token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'], description: 'Overrides the batch-level token for this recipient only.' },
            },
            required: ['service', 'provider', 'account_number', 'amount_ngn'],
            additionalProperties: false,
          },
        },
        chain: { type: 'string', enum: ['CELO', 'BASE'], description: 'Default chain for recipients that don\'t set their own. Falls back to the chain approved when the API key was created.' },
        token: { type: 'string', enum: ['USD₮', 'USDC', 'USA₮'], description: 'Default token for recipients that don\'t set their own. Falls back to the token approved when the API key was created.' },
        customer_email: { type: 'string', description: 'Optional — used for receipts if known, applies to the whole batch.' },
      },
      required: ['pin', 'recipients'],
      additionalProperties: false,
    },
    // Moves real money on-chain for multiple recipients — irreversible, and calling it twice
    // pays everyone twice.
    annotations: { title: 'Pay Bill Batch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    // See the identical note on transaction_history above.
    _meta: { ui: { resourceUri: MCP_UI_CARD_URI } },
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

// 🔒 PER-IDENTITY RATE LIMIT ON SPEND ACTIONS — defense in depth beyond what already exists:
// /api/mcp/route.ts applies a blanket per-IP limit (enforceRateLimit(req, 'mcp', 60, 60)) across
// EVERY tool including free catalogue lookups, and checkPinAllowed's escalating lockout only
// triggers on a WRONG pin. Neither stops a caller who already holds the correct PIN (or a
// leaked api_key/OAuth token) from firing pay_bill/schedule_bill/pay_bill_batch as fast as the
// network allows, and the IP limit alone rotates trivially behind a botnet. This is keyed by the
// identity row's own id — not the wallet address or IP — so it follows the specific credential
// that was actually used, exactly the thing worth slowing down if it leaks.
//
// 🔴 THE GAP THIS CLOSES: `enforceRateLimit` (src/lib/rateLimit.ts) was imported into this file
// from the very first version of the MCP tool layer and never once called — callTool() has no
// `req` to key an IP-based check off, so the import sat dead. rateLimit()'s lower-level, key-only
// form has no such requirement.
async function checkSpendRateLimit(identity: McpIdentity, action: string, limit: number, windowSeconds: number) {
  const result = await rateLimit(`mcp-${action}:${identity.id}`, limit, windowSeconds);
  if (!result.allowed) {
    return errorResult(`Too many ${action.replace(/_/g, ' ')} calls in a short time — try again in about ${result.retryAfterSeconds}s.`);
  }
  return null;
}

// Which four services chat's SCHEDULE_BILL intent will schedule (core/route.ts's check at
// the `['VEND_AIRTIME', 'VEND_DATA', 'ELECTRICITY', 'TV'].includes(...)` gate) — EDUCATION and
// INTERNATIONAL are deliberately excluded here, same as chat.
const SCHEDULABLE_INTENTS: Record<string, string> = {
  AIRTIME: 'VEND_AIRTIME',
  DATA: 'VEND_DATA',
  ELECTRICITY: 'ELECTRICITY',
  CABLE: 'TV',
};

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
  return withCard(textResult(lines.join('\n')), {
    view: 'balance',
    wallet: identity.wallet_address,
    chain,
    defaultToken: identity.approved_token || 'USD₮',
    tokens: tokens.map((sym, i) => ({
      symbol: sym,
      balance: balances[sym] ?? '0.0000',
      limit: allowances[i].ok ? allowances[i].remaining.toFixed(4) : null,
    })),
  });
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
  const offsetRaw = Number(args?.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  // Excludes preflight rows (never-broadcast intents, same convention as cleanupPreflights.ts)
  // — those aren't real transactions a user would recognize as "something I did". `.range`
  // instead of `.limit` so the interactive card's Next/Previous buttons (mcpUiTemplates.ts) can
  // page through history by re-calling this tool with a shifted `offset` — one extra row
  // requested past `limit` (below) is how `hasMore` is known without a separate COUNT query.
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .ilike('wallet_address', identity.wallet_address)
    .not('tx_hash', 'like', 'preflight_%')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit); // limit+1 rows requested — see hasMore below

  if (error) {
    console.error('[MCP] transaction_history query failed:', error.message);
    return errorResult('Could not load transaction history right now — try again shortly.');
  }
  const hasMore = (data?.length ?? 0) > limit;
  if (data && data.length > limit) data.length = limit; // drop the lookahead row before rendering
  if (!data || data.length === 0) {
    return offset > 0
      ? withCard(textResult('No more transactions.'), { view: 'history', wallet: identity.wallet_address, rows: [], offset, limit, hasMore: false })
      : textResult('No transactions found for this wallet yet.');
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
    // Real ₦ glyph for the interactive card — see the identical note in finalizePayBillResult.
    const cardRows = rows.map((r) => ({ ...r, displayAmountNgn: r.displayAmountNgn.replace(/^NGN /, '₦') }));
    return withCard(imageAndTextResult(png, text), { view: 'history', wallet: identity.wallet_address, rows: cardRows, offset, limit, hasMore });
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
      const cryptoCharged = `${Number(row?.amount_usdt ?? capacity.neededCrypto).toFixed(6)} ${tokenSymbol}`;
      const png = await renderReceiptImage({
        status: 'SUCCESS',
        serviceLabel,
        accountNumber,
        customerName: row?.customer_name || customerName || null,
        customerAddress: row?.customer_address || customerAddress || null,
        displayAmountNgn: `NGN ${amountNgn.toLocaleString()}`,
        cryptoCharged,
        purchasedCode: row?.purchased_code || null,
        units: row?.units || null,
        referenceId: row?.request_id || null,
        txHash: result.txHash,
        chain,
      });
      const finalText = receiptUrl ? `${baseText}\nReceipt: ${receiptUrl}` : baseText;
      // 🔴 THE ₦/₮ WORKAROUND ABOVE IS PNG-ONLY: real HTML has no Satori font-subsetting
      // problem, so the interactive card gets the real glyphs instead of the "NGN " prefix
      // the image is stuck with — see mcpUiTemplates.ts's own header comment.
      return withCard(imageAndTextResult(png, finalText), {
        view: 'receipt',
        status: 'SUCCESS',
        serviceLabel,
        accountNumber,
        customerName: row?.customer_name || customerName || null,
        customerAddress: row?.customer_address || customerAddress || null,
        displayAmountNgn: `₦${amountNgn.toLocaleString()}`,
        cryptoCharged,
        purchasedCode: row?.purchased_code || null,
        units: row?.units || null,
        referenceId: row?.request_id || null,
        txHash: result.txHash,
        chain,
        receiptUrl,
      });
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

  const rateLimited = await checkSpendRateLimit(identity, 'pay_bill', 10, 60);
  if (rateLimited) return rateLimited;

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

// ===================== SCHEDULING (MCP parity with chat) =====================

async function callScheduleBill(args: any, oauthIdentity: McpIdentity | null) {
  const apiKey = String(args?.api_key || '');
  const pin = String(args?.pin || '');
  const service = String(args?.service || '').toUpperCase();
  const provider = String(args?.provider || '').toLowerCase().trim();
  const accountNumber = String(args?.account_number || '').trim();
  const amountNgn = Number(args?.amount_ngn);
  const variationCode = args?.variation_code ? String(args.variation_code) : null;
  const meterType = args?.meter_type ? String(args.meter_type) : null;
  const frequency = String(args?.frequency || '').toLowerCase();
  const dayOfWeek = args?.day_of_week !== undefined ? Number(args.day_of_week) : null;
  const dayOfMonth = args?.day_of_month !== undefined ? Number(args.day_of_month) : null;
  const scheduleInMinutes = args?.schedule_in_minutes !== undefined ? Number(args.schedule_in_minutes) : null;
  const customerEmail = args?.customer_email ? String(args.customer_email) : null;
  const chainOverride = args?.chain === 'BASE' || args?.chain === 'CELO' ? args.chain : null;
  const tokenOverride = args?.token ? String(args.token) : null;

  if (!apiKey && !oauthIdentity) return NEEDS_AUTH;
  if (!/^\d{4,6}$/.test(pin)) return errorResult('pin must be 4-6 digits.');

  const intent = SCHEDULABLE_INTENTS[service];
  if (!intent) return errorResult(`service must be one of ${Object.keys(SCHEDULABLE_INTENTS).join(', ')} — EDUCATION and INTERNATIONAL can't be scheduled; pay those directly with pay_bill.`);
  if (!provider) return errorResult('provider is required — e.g. mtn, ikeja-electric, dstv.');
  if (!accountNumber) return errorResult('account_number is required.');
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) return errorResult('amount_ngn must be a positive number.');

  // Same required-field gates pay_bill enforces (parity.ts's requiresVariation, and the
  // ELECTRICITY meter_type check) — a schedule with a missing plan code or meter type would
  // just fail identically on its first run, so it's caught here instead.
  if (requiresVariation(intent, provider) && !variationCode) {
    return errorResult(`variation_code is required for ${service} — call list_plans first and pass back a real code.`);
  }
  if (intent === 'ELECTRICITY' && meterType !== 'prepaid' && meterType !== 'postpaid') {
    return errorResult('meter_type is required for ELECTRICITY and must be exactly "prepaid" or "postpaid".');
  }

  let dayOfWeekFinal: number | null = null;
  let dayOfMonthFinal: number | null = null;
  let runOnceAt: string | null = null;
  if (frequency === 'once') {
    if (!Number.isFinite(scheduleInMinutes) || (scheduleInMinutes as number) <= 0) {
      return errorResult('schedule_in_minutes must be a positive number when frequency is "once".');
    }
    runOnceAt = new Date(Date.now() + (scheduleInMinutes as number) * 60_000).toISOString();
  } else if (frequency === 'weekly') {
    if (!Number.isInteger(dayOfWeek) || (dayOfWeek as number) < 0 || (dayOfWeek as number) > 6) {
      return errorResult('day_of_week is required for weekly schedules — 0 (Sunday) through 6 (Saturday).');
    }
    dayOfWeekFinal = dayOfWeek;
  } else if (frequency === 'monthly') {
    if (!Number.isInteger(dayOfMonth) || (dayOfMonth as number) < 1 || (dayOfMonth as number) > 28) {
      return errorResult('day_of_month is required for monthly schedules — 1 through 28.');
    }
    dayOfMonthFinal = dayOfMonth;
  } else if (frequency !== 'daily') {
    return errorResult('frequency must be one of daily, weekly, monthly, once.');
  }

  // 🔐 Same identity + PIN gate as pay_bill — a schedule is a standing spend, so it gets the
  // same confirmation a one-off payment does, not the lighter check_balance/transaction_history
  // treatment.
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

  const rateLimited = await checkSpendRateLimit(identity, 'schedule_bill', 5, 60);
  if (rateLimited) return rateLimited;

  const gate = await checkServiceAllowed(intent, provider);
  if (!gate.allowed) return errorResult(gate.reason || 'This service is temporarily unavailable.');

  const serviceID = resolveServiceId(intent, provider);
  if (!serviceID) return errorResult(`Unknown provider "${provider}" for ${service}.`);

  const validProviders = await providersForIntent(intent);
  if (validProviders.length > 0 && !validProviders.some(p => p.serviceID.toLowerCase() === serviceID.toLowerCase())) {
    return errorResult(`"${provider}" is not a ${service} provider AbaPay can currently sell. Available: ${validProviders.map(p => p.serviceID).join(', ')}.`);
  }

  const accCheck = checkAccountNumber(intent, accountNumber, provider);
  if (!accCheck.valid) return errorResult(accCheck.error || 'Invalid account number.');

  const amtCheck = await checkAmountLive(intent, amountNgn, { isFixedPlan: !!variationCode, provider: serviceID });
  if (!amtCheck.valid) return errorResult(amtCheck.error || 'Invalid amount.');

  const rules = await getServiceRules();
  const rate = rules.exchangeRate;
  const chain = chainOverride || identity.approved_chain || LEGACY_RECORD_CHAIN;
  const chainTokens = tokensForChain(chain);
  const tokenSymbol = tokenOverride && chainTokens.includes(tokenOverride) ? tokenOverride : (identity.approved_token || 'USD₮');

  // 🔴 SAME TWO-STEP LOGIC chat's buildScheduleConfirm (core/route.ts) uses: the approved
  // allowance alone decides whether this CAN auto-pay — a schedule with no funded allowance is
  // still useful as a notify-only reminder. Balance is only checked (and can BLOCK creation)
  // when it CAN auto-pay: a schedule that would auto-pay but is short on balance right now
  // would just fail on its very first run, so that combination is refused up front instead.
  const neededCrypto = amountNgn / rate;
  const [allowance, balances] = await Promise.all([
    getRemainingAllowance(identity.wallet_address, tokenSymbol, chain),
    fetchCryptoBalances(identity.wallet_address, chain),
  ]);
  const heldToken = Number(balances[tokenSymbol] ?? 0);
  const canAutoPay = allowance.ok && allowance.remaining >= neededCrypto;
  if (canAutoPay && heldToken < neededCrypto) {
    return errorResult(`This would auto-pay (your approved limit covers it), but your ${tokenSymbol} balance on ${chain} (${heldToken.toFixed(4)}) won't cover it — need about ${neededCrypto.toFixed(4)}. Top up first, then schedule it again.`);
  }

  const { error: insertErr } = await supabaseAdmin.from('scheduled_bills').insert({
    wallet_address: identity.wallet_address.toLowerCase(),
    service_id: serviceID,
    service_category: service,
    provider,
    billers_code: accountNumber,
    amount_ngn: amountNgn,
    meter_type: meterType || null,
    variation_code: variationCode,
    blockchain: chain,
    token_used: tokenSymbol,
    frequency,
    day_of_week: dayOfWeekFinal,
    day_of_month: dayOfMonthFinal,
    run_once_at: runOnceAt,
    auto_execute: canAutoPay,
    notify_channel: 'MCP',
    notify_channel_id: null,
    notify_email: customerEmail,
    is_active: true,
  });

  if (insertErr) {
    console.error('[MCP] schedule_bill insert failed:', insertErr.message);
    return errorResult("Couldn't save that automation right now — try again shortly.");
  }

  const when = frequency === 'once'
    ? `once, in about ${scheduleInMinutes} minute${scheduleInMinutes === 1 ? '' : 's'}`
    : frequency === 'weekly'
    ? `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeekFinal as number]}`
    : frequency === 'daily' ? 'every day'
    : `on the ${dayOfMonthFinal}th of each month`;

  return textResult(
    `${frequency === 'once' ? 'Scheduled' : 'Automation set'}: ${provider.toUpperCase()} ${service} — NGN ${amountNgn.toLocaleString()} to ${accountNumber}, ${when}.\n\n` +
    (canAutoPay
      ? `This will auto-pay from your approved ${tokenSymbol} allowance on ${chain} — no further action needed.`
      : `Your approved agent limit for ${tokenSymbol} on ${chain} doesn't currently cover this, so it's saved as notify-only — call pay_bill yourself when it's due.`) +
    (customerEmail ? `\nUpdates go to ${customerEmail}.` : `\nNo notification channel was given — check back with list_schedules or transaction_history to see what happened.`)
  );
}

async function callListSchedules(args: any, oauthIdentity: McpIdentity | null) {
  const resolved = await resolveIdentity(args, oauthIdentity);
  if ('error' in resolved) {
    if (resolved.error === 'missing') return NEEDS_AUTH;
    return errorResult(INVALID_KEY_MSG);
  }
  const identity = resolved.identity;

  const { data, error } = await supabaseAdmin
    .from('scheduled_bills')
    .select('*')
    .ilike('wallet_address', identity.wallet_address)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[MCP] list_schedules query failed:', error.message);
    return errorResult('Could not load schedules right now — try again shortly.');
  }
  if (!data || data.length === 0) {
    return textResult('No active schedules for this wallet.');
  }

  const ordinalDay = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  const lines = data.map((sc: any) => {
    const when = sc.frequency === 'once'
      ? (sc.run_once_at ? `once, at ${new Date(sc.run_once_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'once')
      : sc.frequency === 'weekly'
      ? `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][sc.day_of_week] || '?'}`
      : sc.frequency === 'daily' ? 'daily'
      : sc.day_of_month ? `on the ${ordinalDay(sc.day_of_month)} monthly` : 'monthly';
    return `• id: "${sc.id}" — ${String(sc.provider || '').toUpperCase()} ${sc.service_category} — NGN ${Number(sc.amount_ngn).toLocaleString()} to ${sc.billers_code}, ${when} — ${sc.auto_execute ? 'auto-pays' : 'notify-only'}`;
  });

  const text = `${data.length} active schedule(s) — pass "id" to cancel_schedule to remove one:\n\n${lines.join('\n')}`;
  const cardSchedules = data.map((sc: any) => {
    const when = sc.frequency === 'once'
      ? (sc.run_once_at ? `once, at ${new Date(sc.run_once_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'once')
      : sc.frequency === 'weekly'
      ? `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][sc.day_of_week] || '?'}`
      : sc.frequency === 'daily' ? 'daily'
      : sc.day_of_month ? `on the ${ordinalDay(sc.day_of_month)} monthly` : 'monthly';
    return {
      id: sc.id,
      provider: String(sc.provider || '').toUpperCase(),
      service: sc.service_category,
      displayAmountNgn: `₦${Number(sc.amount_ngn).toLocaleString()}`,
      accountNumber: sc.billers_code,
      when,
      autoExecute: !!sc.auto_execute,
    };
  });
  return withCard(textResult(text), { view: 'schedules', schedules: cardSchedules });
}

async function callCancelSchedule(args: any, oauthIdentity: McpIdentity | null) {
  const resolved = await resolveIdentity(args, oauthIdentity);
  if ('error' in resolved) {
    if (resolved.error === 'missing') return NEEDS_AUTH;
    return errorResult(INVALID_KEY_MSG);
  }
  const identity = resolved.identity;
  const id = args?.id ? String(args.id) : null;
  const provider = args?.provider ? String(args.provider).toUpperCase() : null;

  const { data: scheds, error } = await supabaseAdmin
    .from('scheduled_bills')
    .select('id, provider, service_category')
    .ilike('wallet_address', identity.wallet_address)
    .eq('is_active', true);

  if (error) {
    console.error('[MCP] cancel_schedule query failed:', error.message);
    return errorResult('Could not load schedules right now — try again shortly.');
  }
  if (!scheds || scheds.length === 0) {
    return textResult('No active schedules to cancel.');
  }

  // Same "no filter = cancel everything" parity as chat's CANCEL_SCHEDULE (core/route.ts) —
  // documented in the tool description so a caller isn't surprised by it.
  const target = (scheds as any[]).filter((sc) =>
    (!id || String(sc.id) === id) && (!provider || String(sc.provider || '').toUpperCase() === provider)
  );

  if (target.length === 0) {
    return errorResult('No active schedule matched that id/provider. Call list_schedules to see real ids.');
  }

  const { error: updErr } = await supabaseAdmin.from('scheduled_bills').update({ is_active: false }).in('id', target.map((t: any) => t.id));
  if (updErr) {
    console.error('[MCP] cancel_schedule update failed:', updErr.message);
    return errorResult('Could not cancel right now — try again shortly.');
  }

  return textResult(`Cancelled ${target.length} schedule${target.length === 1 ? '' : 's'}.`);
}

// Only these two services are batchable — same restriction chat's batch handler enforces
// (core/route.ts: `batchIntent !== 'VEND_AIRTIME' && batchIntent !== 'VEND_DATA'`).
const BATCHABLE_INTENTS: Record<string, string> = { AIRTIME: 'VEND_AIRTIME', DATA: 'VEND_DATA' };

interface ValidatedBatchRecipient {
  index: number;
  intent: string;
  service: string;
  provider: string;
  accountNumber: string;
  amountNgn: number;
  variationCode: string | null;
  // Raw overrides only — resolved against identity.approved_chain/approved_token once the
  // identity is known (see the resolution pass right after the PIN gate below). Resolving a
  // chain/token default here, before identity exists, would silently ignore the API key's own
  // approved_chain/approved_token exactly the way pay_bill and schedule_bill never do.
  chainOverride: string | null;
  tokenOverride: string | null;
  chain: string;
  tokenSymbol: string;
  serviceID: string;
}

async function callPayBillBatch(args: any, oauthIdentity: McpIdentity | null) {
  const apiKey = String(args?.api_key || '');
  const pin = String(args?.pin || '');
  const rawRecipients = Array.isArray(args?.recipients) ? args.recipients : null;
  const batchChainOverride = args?.chain === 'BASE' || args?.chain === 'CELO' ? args.chain : null;
  const batchTokenOverride = args?.token ? String(args.token) : null;
  const customerEmail = args?.customer_email ? String(args.customer_email) : null;

  if (!apiKey && !oauthIdentity) return NEEDS_AUTH;
  if (!/^\d{4,6}$/.test(pin)) return errorResult('pin must be 4-6 digits.');
  if (!rawRecipients || rawRecipients.length < 2) return errorResult('recipients must be an array of at least 2 — for a single recipient, use pay_bill instead.');
  if (rawRecipients.length > 20) return errorResult('recipients is capped at 20 per call — split a larger batch across several calls.');

  // Validate EVERY recipient before touching identity/PIN — same "all-or-nothing on obvious
  // mistakes" principle as pay_bill's own field checks, just applied per item. A batch that's
  // half-valid is worse than a clear "fix recipient 3 and resend".
  const validated: ValidatedBatchRecipient[] = [];
  for (let i = 0; i < rawRecipients.length; i++) {
    const r = rawRecipients[i];
    const service = String(r?.service || '').toUpperCase();
    const intent = BATCHABLE_INTENTS[service];
    if (!intent) return errorResult(`recipient ${i + 1}: service must be AIRTIME or DATA — electricity, cable, education, and international are not batchable. Use pay_bill for those.`);

    const provider = String(r?.provider || '').toLowerCase().trim();
    if (!provider) return errorResult(`recipient ${i + 1}: provider is required.`);
    const accountNumber = String(r?.account_number || '').trim();
    if (!accountNumber) return errorResult(`recipient ${i + 1}: account_number is required.`);
    const amountNgn = Number(r?.amount_ngn);
    if (!Number.isFinite(amountNgn) || amountNgn <= 0) return errorResult(`recipient ${i + 1}: amount_ngn must be a positive number.`);
    const variationCode = r?.variation_code ? String(r.variation_code) : null;
    if (requiresVariation(intent, provider) && !variationCode) {
      return errorResult(`recipient ${i + 1}: variation_code is required for DATA — call list_plans first and pass back a real code.`);
    }

    const serviceID = resolveServiceId(intent, provider);
    if (!serviceID) return errorResult(`recipient ${i + 1}: unknown provider "${provider}".`);
    const validProviders = await providersForIntent(intent);
    if (validProviders.length > 0 && !validProviders.some((p) => p.serviceID.toLowerCase() === serviceID.toLowerCase())) {
      return errorResult(`recipient ${i + 1}: "${provider}" is not a ${service} provider AbaPay can currently sell. Available: ${validProviders.map((p) => p.serviceID).join(', ')}.`);
    }
    const accCheck = checkAccountNumber(intent, accountNumber, provider);
    if (!accCheck.valid) return errorResult(`recipient ${i + 1}: ${accCheck.error || 'invalid account number.'}`);
    const amtCheck = await checkAmountLive(intent, amountNgn, { isFixedPlan: !!variationCode, provider: serviceID });
    if (!amtCheck.valid) return errorResult(`recipient ${i + 1}: ${amtCheck.error || 'invalid amount.'}`);

    const chainOverride = (r?.chain === 'BASE' || r?.chain === 'CELO' ? r.chain : null) || batchChainOverride;
    const tokenOverride = (r?.token ? String(r.token) : null) || batchTokenOverride;

    validated.push({
      index: i, intent, service, provider, accountNumber, amountNgn, variationCode, serviceID,
      chainOverride, tokenOverride, chain: '', tokenSymbol: '', // resolved below once identity is known
    });
  }

  // 🔐 Same identity + PIN gate as pay_bill — a batch is a standing multi-recipient spend, so
  // it gets the same confirmation a single payment does.
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

  const rateLimited = await checkSpendRateLimit(identity, 'pay_bill_batch', 5, 60);
  if (rateLimited) return rateLimited;

  // Now that the identity is known, resolve each recipient's actual chain/token — same
  // fallback order pay_bill uses (explicit override || the API key's approved default ||
  // LEGACY_RECORD_CHAIN), unavailable during the pre-identity validation pass above.
  for (const v of validated) {
    v.chain = v.chainOverride || identity.approved_chain || LEGACY_RECORD_CHAIN;
    const chainTokens = tokensForChain(v.chain);
    v.tokenSymbol = v.tokenOverride && chainTokens.includes(v.tokenOverride) ? v.tokenOverride : (identity.approved_token || 'USD₮');
  }

  // ⚡ OPERATOR GATE on the TOTAL — the per-tx cap alone would let a batch slip past a daily
  // cap by splitting it across recipients. Same principle as core/route.ts's batchGate.
  const totalNgn = validated.reduce((s, v) => s + v.amountNgn, 0);
  const spendGate = await checkAgentSpendAllowed(supabaseAdmin, identity.wallet_address, totalNgn);
  if (!spendGate.allowed) return errorResult(spendGate.reason || 'Agent spending is currently disabled for this account.');

  // Per-service-allowed gate, deduped so a 20-recipient batch with 2 providers doesn't run the
  // same check 20 times.
  const seenGates = new Set<string>();
  for (const v of validated) {
    const gateKey = `${v.intent}|${v.provider}`;
    if (seenGates.has(gateKey)) continue;
    seenGates.add(gateKey);
    const gate = await checkServiceAllowed(v.intent, v.provider);
    if (!gate.allowed) return errorResult(`${v.provider.toUpperCase()}: ${gate.reason || 'temporarily unavailable.'}`);
  }

  const rules = await getServiceRules();
  const rate = rules.exchangeRate;

  // Capacity per (chain, token) group against that group's own subtotal — mirrors
  // core/route.ts's batch handler exactly. ALL groups must clear before ANYTHING executes.
  const items: BatchItem[] = validated.map((v) => ({
    serviceCategory: v.service, serviceID: v.serviceID, provider: v.provider,
    billersCode: v.accountNumber, amountNgn: v.amountNgn, chain: v.chain, tokenSymbol: v.tokenSymbol,
    variationCode: v.variationCode || undefined,
  }));
  const groups = groupByChainToken(items);
  for (const [key, groupItems] of groups) {
    const [gChain, gToken] = key.split('|');
    const gTotal = groupItems.reduce((s, it) => s + it.amountNgn, 0);
    const capacity = await checkAutonomousCapacity(identity.wallet_address, gChain, gToken, gTotal, rate);
    if (!capacity.ok) return errorResult(`${gToken} on ${gChain}: ${capacity.reason}`);
  }

  // Execute sequentially, exactly like core/route.ts's batch handler — these relay through a
  // shared on-chain path per recipient, and running them one at a time (not in parallel) avoids
  // nonce/relayer contention between recipients in the same call.
  const results: { v: ValidatedBatchRecipient; result: AgentPaymentResult }[] = [];
  for (const v of validated) {
    const item: BatchItem = {
      serviceCategory: v.service, serviceID: v.serviceID, provider: v.provider,
      billersCode: v.accountNumber, amountNgn: v.amountNgn, chain: v.chain, tokenSymbol: v.tokenSymbol,
      variationCode: v.variationCode || undefined,
    };
    const result = await executeAgentPayment({
      userWallet: identity.wallet_address, item, exchangeRate: rate, sourceChannel: 'MCP',
      email: customerEmail, variationCode: v.variationCode,
    });
    results.push({ v, result });
  }

  const okCount = results.filter((r) => r.result.success).length;
  const totalCharged = results.filter((r) => r.result.success).reduce((s, r) => s + r.v.amountNgn, 0);

  // One aggregate out-of-band alert for the whole batch rather than one per recipient — the
  // owner learns money moved without N separate pings for N small payments. Never blocks the
  // result on alerting, same as pay_bill's finalizePayBillResult.
  if (okCount > 0) {
    try {
      await notifySpendOutOfBand(identity.wallet_address, {
        amountNgn: totalCharged, amountCrypto: (totalCharged / rate).toFixed(6), token: 'mixed tokens',
        service: `BATCH (${okCount}/${validated.length} recipients)`, account: `${okCount} recipients`,
        channel: 'MCP', txHash: '', remaining: 'see check_balance for per-token limits',
      });
    } catch { /* never block a result on alerting */ }
  }

  const lines = results.map(({ v, result }, i) => {
    const label = `${i + 1}. ${v.provider.toUpperCase()} ${v.service} — NGN ${v.amountNgn.toLocaleString()} to ${v.accountNumber}`;
    if (result.success && !result.vendFailed) return `${label} — OK${result.txHash ? ` (${result.txHash.slice(0, 10)}...)` : ''}`;
    if (result.pending) return `${label} — sent, still confirming`;
    return `${label} — FAILED: ${result.message}`;
  });

  const summary = okCount === validated.length
    ? `All ${validated.length} payments sent — NGN ${totalCharged.toLocaleString()} total.`
    : `${okCount} of ${validated.length} payments went through — NGN ${totalCharged.toLocaleString()} charged.`;

  return withCard(textResult(`${summary}\n\n${lines.join('\n')}`), {
    view: 'batch',
    okCount,
    totalCount: validated.length,
    totalNgn: totalCharged,
    totalDisplay: `₦${totalCharged.toLocaleString()}`,
    recipients: results.map(({ v, result }) => ({
      provider: v.provider.toUpperCase(),
      service: v.service,
      accountNumber: v.accountNumber,
      displayAmountNgn: `₦${v.amountNgn.toLocaleString()}`,
      status: result.success && !result.vendFailed ? 'OK' : result.pending ? 'PENDING' : 'FAILED',
      txHash: result.txHash || null,
    })),
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
    case 'schedule_bill': return callScheduleBill(args, oauthIdentity);
    case 'list_schedules': return callListSchedules(args, oauthIdentity);
    case 'cancel_schedule': return callCancelSchedule(args, oauthIdentity);
    case 'pay_bill_batch': return callPayBillBatch(args, oauthIdentity);
    default: return null;
  }
}

