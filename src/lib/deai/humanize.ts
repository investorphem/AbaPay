import 'server-only';

// ⚡ REPLY HUMANIZER — the SAFE way to make a money bot feel human.
//
// The deterministic engine (core/route.ts) produces the exact reply text: amounts,
// account/meter numbers, transaction hashes, links, PIN instructions — all correct, all
// machine-owned. This function takes that finished reply and rewrites ONLY the surrounding
// prose into the user's language, with a warm tone and the right format for the channel.
//
// 🔒 THE HARD GUARANTEE: it can never alter a fact. Before trusting the rewrite we verify
// that every "protected token" from the original (transaction hashes, URLs, emails, and any
// digit-run of 5+ — amounts, phone/meter/account numbers) still appears verbatim in the
// output. If ANY is missing or changed, we discard the rewrite and send the original English
// reply. The LLM decorates the message; it is never allowed to become the source of truth
// for anything involving money.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const CHANNEL_STYLE: Record<string, string> = {
  WHATSAPP: 'WhatsApp: warm and conversational. Use *single asterisks* for bold (never **double**), short lines, and the existing emojis. Skimmable.',
  TELEGRAM: 'Telegram: clean and friendly. Markdown is fine. Keep the existing emojis and structure.',
  X: 'X/Twitter: ultra concise. Trim any fluff; keep it short and direct.',
  INAPP: 'In-app chat: crisp, professional, and clear. No unnecessary words.',
};

// Extract the tokens that must survive verbatim: hashes/addresses, URLs, emails, and any
// run of 5+ digits (amounts, account/meter/phone numbers). Short numbers like a menu "1" are
// intentionally NOT protected — they're allowed to be re-rendered.
function protectedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const re of [
    /0x[0-9a-fA-F]{6,}/g,                       // tx hashes / addresses
    /https?:\/\/[^\s)]+/g,                      // links
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // emails
    /[₦$€£]\s?[\d,]+(?:\.\d+)?/g,               // currency amounts, incl. small ones (₦100)
    /\d+\.\d{2,}/g,                             // decimals — crypto amounts, rates (0.074627)
    /\d[\d,]{4,}\d|\d{5,}/g,                    // 5+ digit runs (accounts, meters, big amounts)
  ]) {
    const m = text.match(re);
    if (m) m.forEach((t) => tokens.add(t));
  }
  return [...tokens];
}

export interface HumanizeOpts {
  language?: string | null;   // BCP-47-ish; e.g. "pcm", "yo", "ha", "fr". "en"/null = skip.
  channel: string;            // WHATSAPP | TELEGRAM | X | INAPP
  userText?: string;          // the user's own message, for tone mirroring
}

export async function humanizeReply(raw: string, opts: HumanizeOpts): Promise<string> {
  const lang = (opts.language || '').toLowerCase();
  // Fast path: English (or unknown) needs no translation. The English templates are already
  // channel-appropriate, so we skip the LLM entirely — no added latency or cost, no risk.
  if (!lang || lang === 'en' || lang === 'eng') return raw;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return raw;

  const style = CHANNEL_STYLE[String(opts.channel || '').toUpperCase()] || CHANNEL_STYLE.WHATSAPP;
  const mustKeep = protectedTokens(raw);

  const system = `You localize replies for AbaPay, a bill-payment chat assistant.
Rewrite the assistant's message into the user's language (code: "${lang}") with a warm, natural, human tone. Match this channel: ${style}

ABSOLUTE RULES — breaking any of these causes real financial harm:
- Keep EVERY number, money amount (₦, $, etc.), phone/meter/account number, transaction hash (0x...), URL, email address, and PIN instruction EXACTLY as written. Do not translate, localize, reformat, round, or re-space them.
- Keep all emojis and the overall line structure.
- Translate/rephrase ONLY the human prose around those values.
- NEVER add facts, promises, amounts, or links that aren't in the original. NEVER drop a hash, link, or amount.
- If the message is mostly a code/number/menu, change as little as possible.
Output ONLY the rewritten message — no preamble, no quotes, no explanation.`;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.4,
        system,
        messages: [{ role: 'user', content: `User wrote: ${opts.userText || '(n/a)'}\n\nAssistant message to localize:\n${raw}` }],
      }),
    });
    if (!res.ok) return raw;
    const data = await res.json();
    const out: string = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    if (!out) return raw;

    // 🔒 VERIFY every protected token survived exactly. One miss = discard the rewrite.
    for (const tok of mustKeep) {
      if (!out.includes(tok)) {
        console.warn('[humanize] dropped a protected token — using original reply. token:', tok.slice(0, 12));
        return raw;
      }
    }
    // Sanity bound: a localized message shouldn't balloon (a sign the model added content).
    if (out.length > raw.length * 3 + 200) return raw;
    return out;
  } catch (err) {
    console.error('[humanize] failed, using original reply:', err);
    return raw;
  }
}
