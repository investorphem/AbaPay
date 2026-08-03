import { NextResponse } from 'next/server';
import { getBanks, validateAccountRaw } from '@/lib/monnify';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sendTelegramAlert } from '@/lib/telegram';
import { BANK_SEED } from '@/lib/providerFallback';

// ⚡ AUTO-DETECT: "here's an account number, which bank is it?" ⚡
//
// Nigerian NUBAN account numbers don't encode the bank — there's no algorithm to derive it
// from the digits. The only real way to find out (same approach Paystack/Mono use) is to try
// the number against Monnify's free Name Enquiry endpoint for each bank until one returns a
// real account name.
//
// This has gone through two real-world-measured iterations:
//   1. Sequential batches of 8 (a "polite pacing" guess, never a documented Monnify limit),
//      sweeping ALL ~373 of Monnify's real registered banks/MFBs/fintechs. Measured live: 185
//      SECONDS end to end — the frontend's own timeout aborted every attempt long before the
//      server finished, indistinguishable from the feature not working at all.
//   2. Fired all 373 in one parallel Promise.all instead. Much faster, but overwhelmed
//      Monnify's sandbox: 265-275 of 373 calls failed outright on consecutive real tests, and
//      the handful that DID respond in time were effectively random — explaining why
//      suggestions surfaced obscure banks nobody intended, on top of tripping the
//      "DEGRADED" alert below on every attempt.
// Root cause of both: sweeping the FULL list at all. Nobody needs their bank auto-detected
// against 373 institutions — restricting the sweep to the ~23 banks/fintechs people actually
// bank with (the same curated set BANK_SEED already maintains as the offline catalogue
// fallback) fixes both problems at once: a small, fast, reliable concurrent burst, and any
// match found is inherently one of the banks a real customer is likely to intend. If none of
// those match, we say so and let the user pick manually rather than falling back to a slow,
// unreliable sweep of the remaining ~350.
const POPULAR_BANK_CODES = new Set(BANK_SEED.map((b) => b.code));
const RESOLVE_CALL_TIMEOUT_MS = 6_000;

export async function POST(req: Request) {
  // Expensive: up to ~25 Name Enquiry calls per hit. Throttle harder than a single verify.
  const limited = await enforceRateLimit(req, 'monnify-resolve', 8, 60);
  if (limited) return limited;

  try {
    const { accountNumber } = await req.json();

    if (typeof accountNumber !== 'string' || !/^\d{10}$/.test(accountNumber)) {
      return NextResponse.json({ success: false, message: 'A valid 10-digit account number is required.' }, { status: 400 });
    }

    const { banks: allBanks } = await getBanks();
    const banks = allBanks.filter((b) => POPULAR_BANK_CODES.has(b.code));

    // 🔴 THE BUG THIS FIXES: validateAccount() (the old call here) collapses TWO completely
    // different outcomes into the same `null` — "Monnify checked and this isn't the right
    // bank" and "the Name Enquiry call itself failed" (rate-limited, network blip, bad
    // credentials). That meant a real problem (e.g. Monnify's sandbox throttling this route's
    // concurrent batch of NETWORK_ERROR every single call) was indistinguishable from a clean
    // "genuinely no match" — and since this route ALSO always returned `success: true` even
    // with zero matches, the frontend's own fallback ("Couldn't Detect Bank — please select
    // manually") never fired either. The user saw nothing: no suggestion chips, no error toast,
    // just silence — read as "auto-detect doesn't work" with zero signal as to why.
    // Using validateAccountRaw directly keeps responseCode/requestSuccessful visible so this
    // route can tell a real outage apart from an honest non-match and respond accordingly.
    const attempts = await Promise.all(banks.map(async (bank) => {
      const raw = await validateAccountRaw(accountNumber, bank.code, RESOLVE_CALL_TIMEOUT_MS);
      return { bank, raw };
    }));

    const matches = attempts
      .filter((a) => a.raw.result)
      .map((a) => ({ bankCode: a.bank.code, bankName: a.bank.name, accountName: a.raw.result!.accountName }));

    const errorCount = attempts.filter((a) => a.raw.responseCode === 'NETWORK_ERROR').length;

    if (matches.length === 0 && banks.length > 0 && errorCount >= banks.length * 0.5) {
      // Most of the sweep failed outright rather than cleanly rejecting — Monnify itself is
      // having an issue (or this route is getting rate-limited by them), not "wrong bank".
      // Alert once per call (best-effort, never blocks the response) so this is visible
      // without the user having to notice anything beyond a normal-looking toast.
      sendTelegramAlert(`⚠️ *BANK AUTO-DETECT DEGRADED*\n\n${errorCount}/${banks.length} Name Enquiry calls failed outright during resolve — Monnify may be rate-limiting or unreachable.`).catch(() => {});
      return NextResponse.json({
        success: false,
        matches: [],
        message: "Couldn't check your bank right now — please select it manually.",
      });
    }

    return NextResponse.json({ success: matches.length > 0, matches });
  } catch (error: any) {
    console.error('[Monnify] resolve route failed:', error.message);
    return NextResponse.json({ success: false, matches: [], message: 'Could not resolve this account right now.' }, { status: 500 });
  }
}
