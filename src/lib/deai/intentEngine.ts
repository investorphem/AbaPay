import 'server-only';

// ⚡ DeAI INTENT ENGINE — powered by Claude
//
// Replaces the previous Gemini implementation. Uses the Anthropic Messages API directly
// via fetch (no SDK dependency — keeps the lockfile clean).
//
// We use Haiku: intent routing is a high-volume, latency-sensitive, low-complexity task.
// A bigger model would be slower and more expensive for no accuracy gain here.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export type DeAIIntent =
  | 'VEND_AIRTIME'
  | 'VEND_DATA'
  | 'PAY_ELECTRICITY'
  | 'PAY_CABLE'
  | 'BANK_TRANSFER'
  | 'EDUCATION'
  | 'INTERNATIONAL'
  | 'CHECK_BALANCE'
  | 'TRANSACTION_HISTORY'
  | 'SCHEDULE_BILL'
  | 'LIST_SCHEDULES'
  | 'CANCEL_SCHEDULE'
  | 'HELP'
  | 'UNKNOWN';

export interface ParsedRecipient {
  provider: string | null;
  amount_ngn: number | null;
  destination_account: string | null;
}

export interface ParsedIntent {
  intent: DeAIIntent;
  provider: string | null;        // MTN | AIRTEL | GLO | 9MOBILE | disco id | dstv/gotv...
  amount_ngn: number | null;
  destination_account: string | null;  // phone / meter / smartcard
  meter_type: 'prepaid' | 'postpaid' | null;
  confidence_score: number;
  missing: string[];              // what we still need from the user

  // ⚡ Recurrence — set when the user is asking for a RECURRING payment,
  // e.g. "every Tuesday buy 200 airtime" or "pay my meter on the 28th monthly".
  country: string | null;         // ISO code, e.g. "NG" | "GH". Non-NG => INTERNATIONAL.
  is_recurring: boolean;
  frequency: 'daily' | 'weekly' | 'monthly' | null;
  day_of_week: number | null;     // 0=Sunday .. 6=Saturday
  day_of_month: number | null;    // 1-28

  // ⚡ One-off future execution — "buy me MTN airtime in the next 10 minutes". Distinct from
  // is_recurring: this fires exactly ONCE, `schedule_in_minutes` minutes from now. Null for
  // an immediate ("right now") request or a genuinely recurring one.
  schedule_in_minutes: number | null;

  // ⚡ Multiple recipients in one message — "send 500 airtime to 08011111111 and 1000 data
  // to 08022222222". Populated ONLY when 2+ distinct recipients are named; the singular
  // provider/amount_ngn/destination_account fields above are null in that case (use this
  // array instead). Left null/empty for the ordinary single-recipient case.
  recipients: ParsedRecipient[] | null;
}

const SYSTEM_PROMPT = `You are the intent-routing engine for AbaPay, a Web3 utility bill payment app used in Nigeria.

Your ONLY job is to read a user's chat message and extract structured transaction details.
You must respond with a single valid JSON object and NOTHING else — no prose, no markdown, no code fences.

Schema:
{
  "intent": "VEND_AIRTIME" | "VEND_DATA" | "PAY_ELECTRICITY" | "PAY_CABLE" | "BANK_TRANSFER" | "EDUCATION" | "INTERNATIONAL" | "CHECK_BALANCE" | "TRANSACTION_HISTORY" | "SCHEDULE_BILL" | "LIST_SCHEDULES" | "CANCEL_SCHEDULE" | "HELP" | "UNKNOWN",
  "provider": string | null,
  "amount_ngn": number | null,
  "destination_account": string | null,
  "meter_type": "prepaid" | "postpaid" | null,
  "confidence_score": number,
  "missing": string[],
  "country": string | null,
  "is_recurring": boolean,
  "frequency": "daily" | "weekly" | "monthly" | null,
  "day_of_week": number | null,
  "day_of_month": number | null,
  "schedule_in_minutes": number | null,
  "recipients": [{ "provider": string | null, "amount_ngn": number | null, "destination_account": string | null }] | null
}

Rules:
1. Convert slang amounts: "2k" -> 2000, "500 naira" -> 500, "1.5k" -> 1500.
2. Telecom providers must be one of: MTN, AIRTEL, GLO, 9MOBILE. Infer from Nigerian phone prefixes when the user doesn't say:
   - MTN: 0803 0806 0703 0706 0813 0816 0810 0814 0903 0906 0913 0916
   - AIRTEL: 0802 0808 0708 0812 0701 0902 0907 0901 0912
   - GLO: 0805 0807 0705 0815 0811 0905 0915
   - 9MOBILE: 0809 0817 0818 0909 0908
3. Electricity providers (discos) include: ikeja-electric, eko-electric, abuja-electric, ibadan-electric, enugu-electric, portharcourt-electric, kano-electric, jos-electric, kaduna-electric, benin-electric, aba-electric, yola-electric.
4. Cable providers: dstv, gotv, startimes, showmax.
5. destination_account is the phone number, meter number, or smartcard/IUC number.
6. For electricity, meter_type is "prepaid" or "postpaid" — null if the user didn't say.
7. "missing" lists the fields you still need to complete the transaction. Use these exact strings:
   "provider", "amount", "account", "meter_type".
   Only list what is genuinely absent. For CHECK_BALANCE / TRANSACTION_HISTORY / HELP, "missing" is [].
8. confidence_score is 0.0-1.0. Be honest — if you're guessing, score low.
9. If the message isn't a payment request or a supported command, intent is "UNKNOWN".
10. NEVER return "UNKNOWN" just because details are missing. Users write in every style —
   terse, casual, Nigerian Pidgin, formal — and most give partial requests. If the message
   expresses ANY recognisable intent to use one of your services, extract that intent and
   list what's missing; only use "UNKNOWN" when the message doesn't relate to any capability
   at all (small talk, an unrelated question, gibberish).
   - "I want to top up" / "recharge my line" / "buy credit" -> VEND_AIRTIME, missing ["provider","amount","account"] (all Nigerian slang for airtime).
   - "balance" / "check my balance" / "how much do I have" -> CHECK_BALANCE.
   - "I need data" / "buy me some MB" / "browsing data abeg" -> VEND_DATA, missing ["destination_account"] (or more, if genuinely absent).
   - "light don go, need to buy units" -> PAY_ELECTRICITY, missing whatever isn't stated (Nigerian Pidgin for "the power went out").
   - A single greeting with nothing else ("hi", "hello") when nothing else is stated -> "UNKNOWN" is correct here, since there's genuinely no intent yet.

11. RECURRENCE — set is_recurring=true when the user wants this to repeat:
   - "every Tuesday buy 200 airtime"        -> intent VEND_AIRTIME, is_recurring true, frequency "weekly", day_of_week 2
   - "pay my meter on the 28th every month" -> intent PAY_ELECTRICITY, is_recurring true, frequency "monthly", day_of_month 28
   - "buy 100 airtime daily"                -> is_recurring true, frequency "daily"
   day_of_week: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
   day_of_month must be 1-28 (so it exists in every month). If they say 29/30/31, use 28.
   For a ONE-OFF payment, is_recurring is false and the three recurrence fields are null.
12. "show my schedules" / "list my automations" -> LIST_SCHEDULES.
    "cancel my airtime schedule" / "stop my automation" -> CANCEL_SCHEDULE.

13. ONE-OFF FUTURE EXECUTION — set schedule_in_minutes when the user wants this specific
   payment to happen once, at a near-term future moment, rather than right now:
   - "buy me 500 MTN airtime in the next 10 minutes" -> schedule_in_minutes: 10
   - "top up 08012345678 in an hour"                 -> schedule_in_minutes: 60
   - "in half an hour, buy 1000 data for me"         -> schedule_in_minutes: 30
   - "in 2 days pay my electricity bill"             -> schedule_in_minutes: 2880
   This is DIFFERENT from is_recurring — it fires exactly once. Do not set both
   schedule_in_minutes and is_recurring=true for the same message. If the user gives no time
   at all ("buy me airtime"), schedule_in_minutes is null (they mean right now).

14. MULTIPLE RECIPIENTS — when the user names 2 or more distinct recipients/accounts for
   airtime or data in ONE message, populate "recipients" as an array and leave the singular
   provider/amount_ngn/destination_account fields null:
   - "send 500 airtime to 08011111111 and 1000 to 08033333333 (glo)" ->
     recipients: [
       { "provider": null, "amount_ngn": 500, "destination_account": "08011111111" },
       { "provider": "GLO", "amount_ngn": 1000, "destination_account": "08033333333" }
     ]
   Infer each recipient's network from its own phone prefix same as rule 2, when not stated.
   For a single recipient, leave "recipients" null and use the ordinary singular fields —
   do NOT wrap a single recipient in a one-item array.

Never invent an account number or amount. If it isn't in the message, it's null.`;

export async function parseIntent(message: string): Promise<ParsedIntent> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[DeAI] ANTHROPIC_API_KEY is not set.');
    return fallbackIntent();
  }

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0,           // deterministic routing
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: message },
          // Prefill the assistant turn with "{" so the model is forced straight into JSON
          // and cannot emit a preamble. We re-add the brace when parsing.
          { role: 'assistant', content: '{' },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[DeAI] Anthropic API error:', res.status, errText.slice(0, 300));
      return fallbackIntent();
    }

    const data = await res.json();
    const text = (data?.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    // Re-attach the prefilled brace and strip any trailing junk.
    const raw = '{' + text;
    const jsonStr = raw.slice(0, raw.lastIndexOf('}') + 1);

    const parsed = JSON.parse(jsonStr);
    return normalize(parsed);
  } catch (err) {
    console.error('[DeAI] Intent parsing failed:', err);
    return fallbackIntent();
  }
}

function fallbackIntent(): ParsedIntent {
  return {
    intent: 'UNKNOWN',
    provider: null,
    amount_ngn: null,
    destination_account: null,
    meter_type: null,
    confidence_score: 0,
    missing: [],
    country: null,
    is_recurring: false,
    frequency: null,
    day_of_week: null,
    day_of_month: null,
    schedule_in_minutes: null,
    recipients: null,
  };
}

const MAX_SCHEDULE_MINUTES = 10080; // 7 days — beyond that, this isn't a "near-term one-off" anymore

function normalizeRecipients(raw: any): ParsedRecipient[] | null {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .filter((r: any) => r && typeof r === 'object')
    .map((r: any) => {
      const amt = Number(r?.amount_ngn);
      return {
        provider: typeof r?.provider === 'string' ? r.provider.toUpperCase() : null,
        amount_ngn: Number.isFinite(amt) && amt > 0 ? amt : null,
        destination_account: typeof r?.destination_account === 'string' ? r.destination_account.replace(/\s+/g, '') : null,
      };
    })
    // A recipient we can't actually act on (no amount or no account) is worse than useless —
    // drop it rather than let it silently become a $0 or accountless payment downstream.
    .filter((r) => r.amount_ngn !== null && r.destination_account);

  // Rule 14: a single recipient must NOT come back as a one-item array — that's the ordinary
  // singular-field case, and downstream code only branches into "batch mode" on 2+.
  return cleaned.length >= 2 ? cleaned : null;
}

// Defensive normalisation — never trust model output shape blindly.
function normalize(p: any): ParsedIntent {
  const validIntents: DeAIIntent[] = [
    'VEND_AIRTIME', 'VEND_DATA', 'PAY_ELECTRICITY', 'PAY_CABLE',
    'CHECK_BALANCE', 'TRANSACTION_HISTORY', 'SCHEDULE_BILL', 'LIST_SCHEDULES',
    'CANCEL_SCHEDULE', 'BANK_TRANSFER', 'EDUCATION', 'INTERNATIONAL', 'HELP', 'UNKNOWN',
  ];

  const intent: DeAIIntent = validIntents.includes(p?.intent) ? p.intent : 'UNKNOWN';
  const amount = Number(p?.amount_ngn);

  return {
    intent,
    provider: typeof p?.provider === 'string' ? p.provider.toUpperCase() : null,
    amount_ngn: Number.isFinite(amount) && amount > 0 ? amount : null,
    destination_account: typeof p?.destination_account === 'string' ? p.destination_account.replace(/\s+/g, '') : null,
    meter_type: p?.meter_type === 'prepaid' || p?.meter_type === 'postpaid' ? p.meter_type : null,
    confidence_score: Number.isFinite(Number(p?.confidence_score)) ? Number(p.confidence_score) : 0,
    missing: Array.isArray(p?.missing) ? p.missing.filter((m: any) => typeof m === 'string') : [],
    country: typeof p?.country === 'string' ? p.country.toUpperCase().slice(0, 2) : null,
    is_recurring: p?.is_recurring === true,
    frequency: ['daily', 'weekly', 'monthly'].includes(p?.frequency) ? p.frequency : null,
    day_of_week: Number.isInteger(p?.day_of_week) && p.day_of_week >= 0 && p.day_of_week <= 6 ? p.day_of_week : null,
    // Clamp to 28 so a schedule exists in every month (no 30th-of-February surprises).
    day_of_month: Number.isInteger(p?.day_of_month) && p.day_of_month >= 1 ? Math.min(p.day_of_month, 28) : null,
    // A one-off request is never also "recurring" — if the model somehow set both, the
    // recurring fields win (schedule_in_minutes is the less common, narrower feature).
    schedule_in_minutes: p?.is_recurring !== true && Number.isFinite(Number(p?.schedule_in_minutes)) && Number(p.schedule_in_minutes) > 0
      ? Math.min(Math.round(Number(p.schedule_in_minutes)), MAX_SCHEDULE_MINUTES)
      : null,
    recipients: normalizeRecipients(p?.recipients),
  };
}
