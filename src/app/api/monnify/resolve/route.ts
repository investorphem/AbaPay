import { NextResponse } from 'next/server';
import { getBanks, validateAccount } from '@/lib/monnify';
import { enforceRateLimit } from '@/lib/rateLimit';

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

    const attempts = await mapWithConcurrency(banks, BATCH_SIZE, async (bank) => {
      const result = await validateAccount(accountNumber, bank.code);
      return result ? { bankCode: bank.code, bankName: bank.name, accountName: result.accountName } : null;
    });

    const matches = attempts.filter((m): m is NonNullable<typeof m> => m !== null);

    return NextResponse.json({ success: true, matches });
  } catch (error: any) {
    console.error('[Monnify] resolve route failed:', error.message);
    return NextResponse.json({ success: false, matches: [], message: 'Could not resolve this account right now.' }, { status: 500 });
  }
}
