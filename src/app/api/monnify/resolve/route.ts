import { NextResponse } from 'next/server';
import { getBanks, validateAccountRaw } from '@/lib/monnify';
import { enforceRateLimit } from '@/lib/rateLimit';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ AUTO-DETECT: "here's an account number, which bank is it?" ⚡
//
// Nigerian NUBAN account numbers don't encode the bank — there's no algorithm to derive it
// from the digits. The only real way to find out (same approach Paystack/Mono use) is to try
// the number against Monnify's free Name Enquiry endpoint for each bank until one returns a
// real account name. Run in small concurrent batches rather than 25+ parallel requests at
// once, so this stays polite to Monnify's rate limits.

const BATCH_SIZE = 8;

async function mapWithConcurrency<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function POST(req: Request) {
  // Expensive: up to ~25 Name Enquiry calls per hit. Throttle harder than a single verify.
  const limited = await enforceRateLimit(req, 'monnify-resolve', 8, 60);
  if (limited) return limited;

  try {
    const { accountNumber } = await req.json();

    if (typeof accountNumber !== 'string' || !/^\d{10}$/.test(accountNumber)) {
      return NextResponse.json({ success: false, message: 'A valid 10-digit account number is required.' }, { status: 400 });
    }

    const { banks } = await getBanks();

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
    const attempts = await mapWithConcurrency(banks, BATCH_SIZE, async (bank) => {
      const raw = await validateAccountRaw(accountNumber, bank.code);
      return { bank, raw };
    });

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
