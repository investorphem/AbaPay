import { NextResponse } from 'next/server';
import { validateAccountRaw } from '@/lib/monnify';
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

    // ⚡ Surface Monnify's OWN responseCode/responseMessage rather than a generic "could not
    // verify" — this is the one real user waiting on a real answer, unlike the auto-detect
    // sweep where a null result for any given bank is the expected default outcome.
    const raw = await validateAccountRaw(accountNumber, bankCode);
    if (!raw.result) {
      return NextResponse.json({ success: false, code: raw.responseCode, message: raw.responseMessage });
    }

    return NextResponse.json({ success: true, accountName: raw.result.accountName });
  } catch (error: any) {
    console.error('[Monnify] verify route failed:', error.message);
    return NextResponse.json({ success: false, code: 'SERVER_ERROR', message: 'Verification failed.' }, { status: 500 });
  }
}
