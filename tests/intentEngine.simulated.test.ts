import { describe, it, expect, vi } from 'vitest';

// intentEngine.ts is marked 'server-only' (a Next.js build-time guard, not a real runtime
// module) — same stub other tests reaching into server-only code use (see tests/a2a.test.ts).
vi.mock('server-only', () => ({}));

const { parseIntent } = await import('@/lib/deai/intentEngine');

// ⚡ SIMULATED-USER REGRESSION HARNESS for the intent engine (src/lib/deai/intentEngine.ts).
//
// WHAT THIS IS: parseIntent() is the one place every chat channel (Telegram/WhatsApp/X) and
// the in-app web chat turns a real human's raw message into structured payment data. It's a
// live call to Claude Haiku (temperature 0), not a keyword matcher — so it already has a real
// shot at typos, slang, and non-English phrasing, but nothing in this repo actually EXERCISED
// that claim against real messages before this file. This is that exercise: realistic
// messages a Nigerian user would actually type — misspelled, code-switched, Pidgin, terse,
// formal — run through the real model, asserting on what actually matters (intent + the
// concrete fields a payment can't proceed without), not exact-string matches the model was
// never promised to hit.
//
// WHAT THIS IS NOT: a mock-based unit test. It calls the real Anthropic API (same one
// production uses) because the whole point is to catch a live prompt/model regression, not to
// re-verify normalize()'s pure logic (that would only prove the test's own fixtures match
// themselves). It costs a handful of real Haiku calls per run and needs ANTHROPIC_API_KEY —
// skipped cleanly (not failed) without one, e.g. in a CI job that doesn't carry secrets.
//
// If a case here starts failing, don't just loosen the assertion — read the actual response in
// the failure output first. It usually means intentEngine.ts's SYSTEM_PROMPT genuinely
// regressed for that phrasing (a model upgrade, a rule that got edited and lost a case it used
// to cover), which is exactly what this file exists to catch before a real user hits it.

const hasKey = !!process.env.ANTHROPIC_API_KEY;

interface Case {
  label: string;
  message: string;
  expectIntent: string | string[];
  // Only asserted when present — leave unset for a field the message doesn't actually pin down.
  provider?: string;
  amountNgn?: number;
  destinationAccount?: string;
  meterType?: 'prepaid' | 'postpaid';
  isRecurring?: boolean;
  frequency?: 'daily' | 'weekly' | 'monthly';
  minRecipients?: number;
}

const CASES: Case[] = [
  // ── Plain English, no typos — sanity baseline ──────────────────────────────────────────
  { label: 'plain airtime request', message: 'Buy 500 naira MTN airtime for 08031234567', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08031234567' },
  { label: 'plain balance check', message: 'What is my wallet balance?', expectIntent: 'CHECK_BALANCE' },

  // ── Typos and misspellings — the literal ask: "understand users typo errors" ───────────
  { label: 'typo\'d airtime + slang amount', message: 'pls buy me 2k airtym for 08145557777, its mtn', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 2000, destinationAccount: '08145557777' },
  { label: 'typo\'d data + shorthand', message: 'i need 1k dta for my glo line 08055512345 abeg', expectIntent: 'VEND_DATA', provider: 'GLO', amountNgn: 1000, destinationAccount: '08055512345' },
  { label: 'typo\'d balance check', message: 'chek my balanse pls', expectIntent: 'CHECK_BALANCE' },
  { label: 'typo\'d electricity + garbled words', message: 'i wan pay eletrisity bil for meter 04512345678, its prepiad', expectIntent: 'PAY_ELECTRICITY', destinationAccount: '04512345678', meterType: 'prepaid' },
  { label: 'heavy typo, no punctuation', message: 'sen 500 airtme too 08023456789 mtnnetwork rite now', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08023456789' },

  // ── Nigerian Pidgin ──────────────────────────────────────────────────────────────────────
  { label: 'pidgin: phone about to die', message: 'my phone dey die abeg send credit come 08098765432 sharp sharp, 300 naira', expectIntent: 'VEND_AIRTIME', amountNgn: 300, destinationAccount: '08098765432' },
  { label: 'pidgin: light don go', message: 'light don go since morning, I wan buy unit for my meter 09876543210, na postpaid', expectIntent: 'PAY_ELECTRICITY', destinationAccount: '09876543210', meterType: 'postpaid' },
  { label: 'pidgin: cannot browse', message: 'my data don finish, I no fit browse whatsapp again, top am up for 08076543210', expectIntent: 'VEND_DATA', destinationAccount: '08076543210' },

  // ── Subtext / situation-described (no explicit product keyword) ────────────────────────
  { label: 'subtext: sitting in the dark', message: "I'm literally sitting in the dark right now, nothing dey work", expectIntent: 'PAY_ELECTRICITY' },
  { label: 'subtext: cant call anybody', message: "my line don cut, I can't call anybody again", expectIntent: 'VEND_AIRTIME' },
  { label: 'subtext: match tonight', message: 'the match is tonight and my DStv subscription just expired', expectIntent: 'PAY_CABLE', provider: 'DSTV' },

  // ── Other languages/scripts, per intentEngine.ts rule 17 ────────────────────────────────
  { label: 'French request', message: "Achète-moi 500 nairas de crédit MTN pour le numéro 08011122233", expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08011122233' },
  { label: 'Hausa-inflected request', message: 'Ina son sayen credit MTN naira 500 don lambar 08099887766', expectIntent: 'VEND_AIRTIME', amountNgn: 500, destinationAccount: '08099887766' },
  { label: 'Yoruba-inflected request', message: 'Mo fe ra airtime GLO fun 08055566677, naira 200', expectIntent: 'VEND_AIRTIME', provider: 'GLO', amountNgn: 200, destinationAccount: '08055566677' },

  // ── Recurring / scheduling phrasing ──────────────────────────────────────────────────────
  { label: 'recurring weekly airtime', message: 'every Tuesday buy 200 naira MTN airtime for 08033322211', expectIntent: 'SCHEDULE_BILL', provider: 'MTN', amountNgn: 200, destinationAccount: '08033322211', isRecurring: true, frequency: 'weekly' },
  { label: 'list schedules, casual phrasing', message: 'wetin be my automations wey don set up', expectIntent: 'LIST_SCHEDULES' },
  { label: 'cancel schedule, casual phrasing', message: 'abeg cancel my airtime automation', expectIntent: 'CANCEL_SCHEDULE' },

  // ── Multiple recipients in one message ──────────────────────────────────────────────────
  { label: 'batch: two recipients, different amounts, typo\'d', message: 'sen 500 airtym to 08011112222 and 1000 too 08033334444 (glo)', expectIntent: 'VEND_AIRTIME', minRecipients: 2 },

  // ── Ambiguous / off-topic — must NOT be forced into a false-positive intent ─────────────
  { label: 'bare greeting is genuinely unknown', message: 'hi', expectIntent: 'UNKNOWN' },
  { label: 'unrelated small talk', message: 'lol that was funny', expectIntent: 'UNKNOWN' },
];

describe.skipIf(!hasKey)('Intent engine — simulated real-user conversations', () => {
  it.each(CASES)('$label', async (c) => {
    const result = await parseIntent(c.message);

    const expected = Array.isArray(c.expectIntent) ? c.expectIntent : [c.expectIntent];
    expect(
      expected.includes(result.intent),
      `"${c.message}"\n  expected intent one of [${expected.join(', ')}], got "${result.intent}" (full result: ${JSON.stringify(result)})`
    ).toBe(true);

    if (c.provider) expect(result.provider, JSON.stringify(result)).toBe(c.provider);
    if (c.amountNgn) expect(result.amount_ngn, JSON.stringify(result)).toBe(c.amountNgn);
    if (c.destinationAccount) expect(result.destination_account, JSON.stringify(result)).toBe(c.destinationAccount);
    if (c.meterType) expect(result.meter_type, JSON.stringify(result)).toBe(c.meterType);
    if (c.isRecurring !== undefined) expect(result.is_recurring, JSON.stringify(result)).toBe(c.isRecurring);
    if (c.frequency) expect(result.frequency, JSON.stringify(result)).toBe(c.frequency);
    if (c.minRecipients) expect(result.recipients?.length ?? 0, JSON.stringify(result)).toBeGreaterThanOrEqual(c.minRecipients);
  }, 30_000);

  // Not a hard assertion (the model owes no exact code — pcm/ha/yo/fr are close cousins and a
  // reasonable model can reasonably disagree at the margins) — this is a VISIBILITY check so a
  // real regression (e.g. everything suddenly coming back "en") is obvious in the test output
  // without making the whole suite flaky on a single borderline call.
  it('reports a plausible language code across a spread of inputs', async () => {
    const probes: { message: string; expected: string }[] = [
      { message: 'Buy 500 naira MTN airtime for 08031234567', expected: 'en' },
      { message: 'Achète-moi 500 nairas de crédit MTN pour le numéro 08011122233', expected: 'fr' },
      { message: 'my phone dey die abeg send credit come 08098765432 sharp sharp, 300 naira', expected: 'pcm' },
    ];
    const results = await Promise.all(probes.map((p) => parseIntent(p.message)));
    const mismatches = results
      .map((r, i) => ({ message: probes[i].message, expected: probes[i].expected, got: r.language }))
      .filter((r) => r.got !== r.expected);

    if (mismatches.length > 0) {
      console.warn('[intentEngine simulated test] language detection mismatch (non-fatal):', JSON.stringify(mismatches, null, 2));
    }
    // Hard requirement: it must at least attempt a code, not silently give up on every probe.
    expect(results.every((r) => !!r.language)).toBe(true);
  }, 30_000);
});
