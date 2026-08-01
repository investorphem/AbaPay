import { NextResponse } from 'next/server';
import { validateAccount } from '@/lib/monnify';
import { enforceRateLimit } from '@/lib/rateLimit';

// Manual single-bank verify — used when auto-detect (/api/monnify/resolve) found no match
// and the user picks a bank themselves, or overrides an auto-detected suggestion.
export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'monnify-verify', 20, 60);
  if (limited) return limited;

  try {
    const { accountNumber, bankCode } = await req.json();

    if (typeof accountNumber !== 'string' || !/^\d{10}$/.test(accountNumber) || typeof bankCode !== 'string' || !bankCode) {
      return NextResponse.json({ success: false, message: 'Account number and bank are required.' }, { status: 400 });
    }

    const result = await validateAccount(accountNumber, bankCode);
    if (!result) {
      return NextResponse.json({ success: false, message: 'Could not verify this account for the selected bank.' });
    }

    return NextResponse.json({ success: true, accountName: result.accountName });
  } catch (error: any) {
    console.error('[Monnify] verify route failed:', error.message);
    return NextResponse.json({ success: false, message: 'Verification failed.' }, { status: 500 });
  }
}
