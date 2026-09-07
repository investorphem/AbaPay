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
  dayOfWeek?: number;
  dayOfMonth?: number;
  hasScheduleInMinutes?: boolean;
  minRecipients?: number;
  chain?: 'CELO' | 'BASE';
  token?: string;
  groupService?: 'AIRTIME' | 'DATA';
}

const CASES: Case[] = [
  // ── Plain English, no typos — sanity baseline ──────────────────────────────────────────
  { label: 'plain airtime request', message: 'Buy 500 naira MTN airtime for 08031234567', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08031234567' },
  { label: 'plain balance check', message: 'What is my wallet balance?', expectIntent: 'CHECK_BALANCE' },
  { label: 'plain transaction history', message: 'Show me my last few transactions', expectIntent: 'TRANSACTION_HISTORY' },

  // ── Typos and misspellings — the literal ask: "understand users typo errors" ───────────
  { label: 'typo\'d airtime + slang amount', message: 'pls buy me 2k airtym for 08145557777, its mtn', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 2000, destinationAccount: '08145557777' },
  { label: 'typo\'d data + shorthand', message: 'i need 1k dta for my glo line 08055512345 abeg', expectIntent: 'VEND_DATA', provider: 'GLO', amountNgn: 1000, destinationAccount: '08055512345' },
  { label: 'typo\'d balance check', message: 'chek my balanse pls', expectIntent: 'CHECK_BALANCE' },
  { label: 'typo\'d electricity + garbled words', message: 'i wan pay eletrisity bil for meter 04512345678, its prepiad', expectIntent: 'PAY_ELECTRICITY', destinationAccount: '04512345678', meterType: 'prepaid' },
  { label: 'heavy typo, no punctuation', message: 'sen 500 airtme too 08023456789 mtnnetwork rite now', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08023456789' },
  { label: 'severely garbled cable request', message: 'i wanna renu my dstv subscribtion pls its urgnt', expectIntent: 'PAY_CABLE', provider: 'DSTV' },
  { label: 'typo\'d postpaid electricity', message: 'pay my lite bil meter 09988776655 its posptaid abeg 5000', expectIntent: 'PAY_ELECTRICITY', destinationAccount: '09988776655', meterType: 'postpaid', amountNgn: 5000 },
  { label: 'typo in phone digits stays literal (no silent correction)', message: 'buy 500 mtn airtime for 0803123456', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '0803123456' },

  // ── Nigerian Pidgin ──────────────────────────────────────────────────────────────────────
  { label: 'pidgin: phone about to die', message: 'my phone dey die abeg send credit come 08098765432 sharp sharp, 300 naira', expectIntent: 'VEND_AIRTIME', amountNgn: 300, destinationAccount: '08098765432' },
  { label: 'pidgin: light don go', message: 'light don go since morning, I wan buy unit for my meter 09876543210, na postpaid', expectIntent: 'PAY_ELECTRICITY', destinationAccount: '09876543210', meterType: 'postpaid' },
  { label: 'pidgin: cannot browse', message: 'my data don finish, I no fit browse whatsapp again, top am up for 08076543210', expectIntent: 'VEND_DATA', destinationAccount: '08076543210' },
  { label: 'pidgin: wetin remain', message: 'wetin remain for my wallet abeg', expectIntent: 'CHECK_BALANCE' },

  // ── Subtext / situation-described (no explicit product keyword) ────────────────────────
  { label: 'subtext: sitting in the dark', message: "I'm literally sitting in the dark right now, nothing dey work", expectIntent: 'PAY_ELECTRICITY' },
  { label: 'subtext: cant call anybody', message: "my line don cut, I can't call anybody again", expectIntent: 'VEND_AIRTIME' },
  { label: 'subtext: match tonight', message: 'the match is tonight and my DStv subscription just expired', expectIntent: 'PAY_CABLE', provider: 'DSTV' },
  { label: 'subtext: ambiguous everything down stays unknown', message: 'everything is just down for me today', expectIntent: 'UNKNOWN' },

  // ── Other languages/scripts, per intentEngine.ts rule 17 ────────────────────────────────
  { label: 'French request', message: 'Achète-moi 500 nairas de crédit MTN pour le numéro 08011122233', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08011122233' },
  { label: 'Hausa-inflected request', message: 'Ina son sayen credit MTN naira 500 don lambar 08099887766', expectIntent: 'VEND_AIRTIME', amountNgn: 500, destinationAccount: '08099887766' },
  { label: 'Yoruba-inflected request', message: 'Mo fe ra airtime GLO fun 08055566677, naira 200', expectIntent: 'VEND_AIRTIME', provider: 'GLO', amountNgn: 200, destinationAccount: '08055566677' },
  { label: 'Igbo-inflected request', message: 'Achọrọ m ịzụta airtime MTN maka 08033221144, naira 300', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 300, destinationAccount: '08033221144' },
  { label: 'Swahili-ish request (non-Nigerian language, still a real request)', message: 'Nataka kununua muda wa maongezi wa MTN kwa 500 naira, namba 08022334455', expectIntent: 'VEND_AIRTIME', provider: 'MTN', amountNgn: 500, destinationAccount: '08022334455' },

  // ── Recurring / scheduling phrasing ──────────────────────────────────────────────────────
  { label: 'recurring weekly airtime', message: 'every Tuesday buy 200 naira MTN airtime for 08033322211', expectIntent: 'SCHEDULE_BILL', provider: 'MTN', amountNgn: 200, destinationAccount: '08033322211', isRecurring: true, frequency: 'weekly', dayOfWeek: 2 },
  { label: 'recurring monthly electricity', message: 'pay my meter 07766554433 on the 28th every month, 3000 naira, prepaid', expectIntent: 'SCHEDULE_BILL', destinationAccount: '07766554433', amountNgn: 3000, meterType: 'prepaid', isRecurring: true, frequency: 'monthly', dayOfMonth: 28 },
  { label: 'recurring daily airtime, casual phrasing', message: 'abeg dey buy 100 naira mtn airtime for 08011223344 every single day', expectIntent: 'SCHEDULE_BILL', provider: 'MTN', amountNgn: 100, destinationAccount: '08011223344', isRecurring: true, frequency: 'daily' },
  { label: 'one-off future execution, minutes phrasing', message: 'buy me 500 MTN airtime for 08099001122 in the next 10 minutes', expectIntent: ['VEND_AIRTIME', 'SCHEDULE_BILL'], provider: 'MTN', amountNgn: 500, destinationAccount: '08099001122', hasScheduleInMinutes: true },
  { label: 'one-off future execution, "in an hour" typo\'d', message: 'top up 08076541230 in an hr, 1k mtn abeg', expectIntent: ['VEND_AIRTIME', 'SCHEDULE_BILL'], destinationAccount: '08076541230', amountNgn: 1000, hasScheduleInMinutes: true },
  { label: 'list schedules, casual phrasing', message: 'wetin be my automations wey don set up', expectIntent: 'LIST_SCHEDULES' },
  { label: 'list schedules, formal phrasing', message: 'Can you show me all of my scheduled payments?', expectIntent: 'LIST_SCHEDULES' },
  { label: 'cancel schedule, casual phrasing', message: 'abeg cancel my airtime automation', expectIntent: 'CANCEL_SCHEDULE' },
  { label: 'cancel schedule, provider-specific', message: 'please cancel my MTN airtime schedule, keep the others', expectIntent: 'CANCEL_SCHEDULE', provider: 'MTN' },

  // ── Multiple recipients in one message ──────────────────────────────────────────────────
  { label: 'batch: two recipients, different amounts, typo\'d', message: 'sen 500 airtym to 08011112222 and 1000 too 08033334444 (glo)', expectIntent: 'VEND_AIRTIME', minRecipients: 2 },
  { label: 'batch: shared amount, bare comma list', message: 'buy 200 naira each airtime to this lines 08011111111,08022222222,08033333333', expectIntent: 'VEND_AIRTIME', minRecipients: 3 },

  // ── Chain/token override ────────────────────────────────────────────────────────────────
  { label: 'chain + token override in one request', message: 'pay 500 mtn airtime for 08012223344 on base with usdt', expectIntent: 'VEND_AIRTIME', destinationAccount: '08012223344', amountNgn: 500, chain: 'BASE', token: 'USD₮' },

  // ── Group bulk recharge (Telegram-group-only) ───────────────────────────────────────────
  { label: 'group bulk recharge, airtime default', message: 'recharge 5 random numbers from the last 30 minutes, 200 each', expectIntent: 'GROUP_BULK_RECHARGE', groupService: 'AIRTIME' },
  { label: 'group bulk recharge, explicit data', message: 'give 5 random numbers from the last 20 minutes data, up to 300 each', expectIntent: 'GROUP_BULK_RECHARGE', groupService: 'DATA' },

  // ── Education (WAEC vs JAMB) ─────────────────────────────────────────────────────────────
  { label: 'WAEC result checker request', message: 'I need to check my WAEC result, buy me the scratch card pin', expectIntent: 'EDUCATION', provider: 'waec' },
  { label: 'JAMB with profile id', message: 'buy my JAMB UTME pin, my profile id na 1234567890', expectIntent: 'EDUCATION', provider: 'jamb', destinationAccount: '1234567890' },

  // ── International ────────────────────────────────────────────────────────────────────────
  { label: 'international top-up request', message: 'top up 20 cedis on my Ghana MTN line +233241234567', expectIntent: 'INTERNATIONAL', destinationAccount: '+233241234567' },

  // ── Ambiguous / off-topic — must NOT be forced into a false-positive intent ─────────────
  { label: 'bare greeting is genuinely unknown', message: 'hi', expectIntent: 'UNKNOWN' },
  { label: 'unrelated small talk', message: 'lol that was funny', expectIntent: 'UNKNOWN' },
  { label: 'thanks-only message stays unknown', message: 'thank you so much!', expectIntent: 'UNKNOWN' },
];

describe.skipIf(!hasKey)('Intent engine — simulated real-user conversations', () => {
  it.each(CASES)('$label', async (c) => {
    const result = await parseIntent(c.message);

    const expected = Array.isArray(c.expectIntent) ? c.expectIntent : [c.expectIntent];
    expect(
      expected.includes(result.intent),
      `"${c.message}"\n  expected intent one of [${expected.join(', ')}], got "${result.intent}" (full result: ${JSON.stringify(result)})`
    ).toBe(true);

    if (c.provider) expect(result.provider, JSON.stringify(result)).toBe(c.provider.toUpperCase());
    if (c.amountNgn) expect(result.amount_ngn, JSON.stringify(result)).toBe(c.amountNgn);
    if (c.destinationAccount) expect(result.destination_account, JSON.stringify(result)).toBe(c.destinationAccount);
    if (c.meterType) expect(result.meter_type, JSON.stringify(result)).toBe(c.meterType);
    if (c.isRecurring !== undefined) expect(result.is_recurring, JSON.stringify(result)).toBe(c.isRecurring);
    if (c.frequency) expect(result.frequency, JSON.stringify(result)).toBe(c.frequency);
    if (c.dayOfWeek !== undefined) expect(result.day_of_week, JSON.stringify(result)).toBe(c.dayOfWeek);
    if (c.dayOfMonth !== undefined) expect(result.day_of_month, JSON.stringify(result)).toBe(c.dayOfMonth);
    if (c.hasScheduleInMinutes) expect(result.schedule_in_minutes, JSON.stringify(result)).toBeGreaterThan(0);
    if (c.minRecipients) expect(result.recipients?.length ?? 0, JSON.stringify(result)).toBeGreaterThanOrEqual(c.minRecipients);
    if (c.chain) expect(result.chain, JSON.stringify(result)).toBe(c.chain);
    if (c.token) expect(result.token, JSON.stringify(result)).toBe(c.token);
    if (c.groupService) expect(result.group_service, JSON.stringify(result)).toBe(c.groupService);
  }, 30_000);

  // Not a hard assertion (the model owes no exact code — pcm/ha/yo/ig/fr/sw are close cousins
  // and a reasonable model can reasonably disagree at the margins) — this is a VISIBILITY
  // check so a real regression (e.g. everything suddenly coming back "en") is obvious in the
  // test output without making the whole suite flaky on a single borderline call.
  it('reports a plausible language code across a spread of inputs', async () => {
    const probes: { message: string; expected: string }[] = [
      { message: 'Buy 500 naira MTN airtime for 08031234567', expected: 'en' },
      { message: 'Achète-moi 500 nairas de crédit MTN pour le numéro 08011122233', expected: 'fr' },
      { message: 'my phone dey die abeg send credit come 08098765432 sharp sharp, 300 naira', expected: 'pcm' },
      { message: 'Mo fe ra airtime GLO fun 08055566677, naira 200', expected: 'yo' },
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

  // A batch (2+ recipients) must NEVER also populate the singular fields — normalize()'s
  // contract (rule 14) is that recipients and the singular provider/amount/account fields are
  // mutually exclusive. A live regression here would silently double-charge or drop recipients
  // downstream in core/route.ts, which branches on "recipients present" vs "singular fields
  // present" and does not expect both.
  it('never populates both recipients and singular fields on a batch request', async () => {
    const result = await parseIntent('send 500 airtime to 08011112222 and 1000 to 08033334444 (glo)');
    if (result.recipients && result.recipients.length >= 2) {
      expect(result.amount_ngn, JSON.stringify(result)).toBeNull();
      expect(result.destination_account, JSON.stringify(result)).toBeNull();
    }
  }, 30_000);
});
