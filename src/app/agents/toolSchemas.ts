// ⚡ SINGLE SOURCE OF TRUTH FOR TOOL DOCS — copied verbatim (name/description/inputSchema
// shape) from src/lib/deai/mcpTools.ts's real TOOLS array, the same object the MCP server
// itself serves via tools/list. A2A exposes the identical 10 skills over JSON-RPC instead of
// MCP's Streamable HTTP — same execution engine, same schemas — so /agents/mcp and /agents/a2a
// both render from this one file instead of maintaining two copies that could drift.
//
// CELO-ONLY, DOCUMENTED. The real backend schema's `chain`/`token` enums also accept BASE/
// non-Celo tokens (this MCP server is shared infrastructure with the multi-chain consumer
// app) — this site's audience is Celo agent infrastructure specifically, so only the Celo
// values are listed here. See each field's `note` for the one-line disclosure rather than
// silently pretending the parameter has no other valid values at all.

export type ParamType = "string" | "number" | "boolean" | "array" | "object";

export interface ToolParam {
  name: string;
  type: ParamType;
  required: boolean;
  enum?: string[];
  description: string;
  note?: string;
}

export interface ToolDef {
  name: string;
  title: string;
  access: "read" | "write" | "destructive";
  description: string;
  params: ToolParam[];
}

export const TOOLS: ToolDef[] = [
  {
    name: "describe_capabilities",
    title: "Describe Capabilities",
    access: "read",
    description: "List what AbaPay can pay (airtime, data, electricity, cable, etc.), any services currently paused, and example requests. Call this first if unsure what is supported.",
    params: [],
  },
  {
    name: "check_balance",
    title: "Check Balance",
    access: "read",
    description: "Check a linked wallet's stablecoin balances and remaining agent spending allowance. Works with no arguments once authorized via OAuth; otherwise pass the api_key.",
    params: [
      { name: "api_key", type: "string", required: false, description: "AbaPay MCP API key (starts with aba_mcp_). Not needed over OAuth." },
      { name: "chain", type: "string", required: false, enum: ["CELO"], description: "Which chain to check.", note: "Backend also accepts BASE for the multi-chain consumer app; this site's rails are Celo-only." },
    ],
  },
  {
    name: "list_plans",
    title: "List Plans",
    access: "read",
    description: "List the REAL, currently purchasable plans for DATA, CABLE, or EDUCATION — exact codes and current prices. Always call before pay_bill for these three services.",
    params: [
      { name: "service", type: "string", required: true, enum: ["DATA", "CABLE", "EDUCATION"], description: "Which service to list plans for." },
      { name: "provider", type: "string", required: true, description: 'e.g. mtn, airtel, glo, 9mobile (data); dstv, gotv, startimes (cable); waec, waec-registration, jamb (education).' },
    ],
  },
  {
    name: "list_international_options",
    title: "List International Options",
    access: "read",
    description: "Browse the live international top-up catalogue (140+ countries) one level at a time: country → product type → operator → priced plan.",
    params: [
      { name: "country", type: "string", required: false, description: 'Country name or ISO code, e.g. "Ghana" or "GH". Omit to list all countries.' },
      { name: "product_type_id", type: "string", required: false, description: "From this country's results. Omit to list product types." },
      { name: "operator_id", type: "string", required: false, description: "From this country + product_type_id's results. Omit to list operators." },
    ],
  },
  {
    name: "transaction_history",
    title: "Transaction History",
    access: "read",
    description: "List recent real transactions for the linked wallet — service, provider, amount, status, tx hash. No PIN required.",
    params: [
      { name: "api_key", type: "string", required: false, description: "Not needed over OAuth." },
      { name: "limit", type: "number", required: false, description: "How many to return. Defaults to 10, max 25." },
      { name: "offset", type: "number", required: false, description: "How many of the most recent to skip. 0 (default) starts at the newest." },
    ],
  },
  {
    name: "pay_bill",
    title: "Pay Bill",
    access: "destructive",
    description: "Pay a real bill — Nigerian (airtime, data, electricity, cable, WAEC/JAMB) or international airtime/data — from the linked wallet, settled on-chain. Executes immediately; no delay parameter exists.",
    params: [
      { name: "api_key", type: "string", required: false, description: "Not needed over OAuth." },
      { name: "pin", type: "string", required: true, description: "4-6 digit PIN. Required on every payment, including over OAuth." },
      { name: "service", type: "string", required: true, enum: ["AIRTIME", "DATA", "ELECTRICITY", "CABLE", "EDUCATION", "INTERNATIONAL"], description: "Which kind of bill." },
      { name: "provider", type: "string", required: false, description: "e.g. mtn, ikeja-electric, dstv, waec. Not used for INTERNATIONAL." },
      { name: "account_number", type: "string", required: true, description: "Phone/meter/smartcard/JAMB ID/destination number, depending on service." },
      { name: "amount_ngn", type: "number", required: false, description: "Amount in Naira. Not needed for INTERNATIONAL." },
      { name: "chain", type: "string", required: false, enum: ["CELO"], description: "Defaults to the chain approved on the key.", note: "Backend also accepts BASE for the consumer app; Celo-only here." },
      { name: "token", type: "string", required: false, enum: ["USD₮", "USDC", "USA₮"], description: "Which stablecoin to pay with. Defaults to the token approved on the key." },
      { name: "variation_code", type: "string", required: false, description: "Required for DATA, EDUCATION, INTERNATIONAL, and CABLE package changes." },
      { name: "meter_type", type: "string", required: false, enum: ["prepaid", "postpaid"], description: "Required for ELECTRICITY." },
      { name: "customer_email", type: "string", required: false, description: "Required for INTERNATIONAL (receipt destination)." },
      { name: "country", type: "string", required: false, description: "Required for INTERNATIONAL." },
      { name: "product_type_id", type: "string", required: false, description: "Required for INTERNATIONAL." },
      { name: "operator_id", type: "string", required: false, description: "Required for INTERNATIONAL." },
    ],
  },
  {
    name: "schedule_bill",
    title: "Schedule Bill",
    access: "write",
    description: "Set up a recurring or future one-off bill payment. Charges nothing when this runs — money only moves later, when the schedule fires and the allowance still covers it. EDUCATION and INTERNATIONAL can't be scheduled.",
    params: [
      { name: "api_key", type: "string", required: false, description: "Not needed over OAuth." },
      { name: "pin", type: "string", required: true, description: "Required to create a schedule." },
      { name: "service", type: "string", required: true, enum: ["AIRTIME", "DATA", "ELECTRICITY", "CABLE"], description: "Which kind of bill." },
      { name: "provider", type: "string", required: false, description: "e.g. mtn, ikeja-electric, dstv." },
      { name: "account_number", type: "string", required: true, description: "Phone/meter/smartcard number." },
      { name: "amount_ngn", type: "number", required: true, description: "Amount to charge each run." },
      { name: "variation_code", type: "string", required: false, description: "Required for DATA and CABLE package changes." },
      { name: "meter_type", type: "string", required: false, enum: ["prepaid", "postpaid"], description: "Required for ELECTRICITY." },
      { name: "frequency", type: "string", required: true, enum: ["daily", "weekly", "monthly", "once"], description: "How often this runs." },
      { name: "day_of_week", type: "number", required: false, description: 'Required when frequency is "weekly" — 0 (Sun) to 6 (Sat).' },
      { name: "day_of_month", type: "number", required: false, description: 'Required when frequency is "monthly" — 1-28.' },
      { name: "schedule_in_minutes", type: "number", required: false, description: 'Required when frequency is "once".' },
      { name: "chain", type: "string", required: false, enum: ["CELO"], description: "Defaults to the key's approved chain.", note: "Celo-only here; backend also accepts BASE for the consumer app." },
      { name: "token", type: "string", required: false, enum: ["USD₮", "USDC", "USA₮"], description: "Defaults to the key's approved token." },
      { name: "customer_email", type: "string", required: false, description: "Notified when this runs — MCP has no persistent channel to message back." },
    ],
  },
  {
    name: "list_schedules",
    title: "List Schedules",
    access: "read",
    description: "List active recurring/one-off bill schedules for the linked wallet. No PIN required. Returns each schedule's id for cancel_schedule.",
    params: [
      { name: "api_key", type: "string", required: false, description: "Not needed over OAuth." },
    ],
  },
  {
    name: "cancel_schedule",
    title: "Cancel Schedule",
    access: "write",
    description: "Cancel one or more active schedules. Pass id for exactly one, provider for all of that provider's, or neither to cancel everything. No PIN required.",
    params: [
      { name: "api_key", type: "string", required: false, description: "Not needed over OAuth." },
      { name: "id", type: "string", required: false, description: "Exact schedule id from list_schedules. Cancels only that one." },
      { name: "provider", type: "string", required: false, description: 'Cancel every active schedule for this provider, e.g. "mtn". Ignored if id is set.' },
    ],
  },
  {
    name: "pay_bill_batch",
    title: "Pay Bill Batch",
    access: "destructive",
    description: "Pay airtime or data to 2-20 recipients in one call, one PIN for the whole batch. All-or-nothing on capacity: if any (chain, token) group is short, nothing moves. Executes immediately.",
    params: [
      { name: "api_key", type: "string", required: false, description: "Not needed over OAuth." },
      { name: "pin", type: "string", required: true, description: "Authorizes the whole batch." },
      { name: "recipients", type: "array", required: true, description: "2-20 objects, each: service (AIRTIME|DATA), provider, account_number, amount_ngn, variation_code (DATA only), chain/token overrides." },
      { name: "chain", type: "string", required: false, enum: ["CELO"], description: "Default chain for recipients that don't set their own." },
      { name: "token", type: "string", required: false, enum: ["USD₮", "USDC", "USA₮"], description: "Default token for recipients that don't set their own." },
      { name: "customer_email", type: "string", required: false, description: "Optional, applies to the whole batch." },
    ],
  },
];

export const ACCESS_LABEL: Record<ToolDef["access"], string> = {
  read: "Read-only",
  write: "Write",
  destructive: "Moves money",
};
