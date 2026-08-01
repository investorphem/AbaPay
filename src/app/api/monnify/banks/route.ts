import { NextResponse } from 'next/server';
import { getBanks } from '@/lib/monnify';
import { enforceRateLimit } from '@/lib/rateLimit';

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'monnify-banks', 30, 60);
  if (limited) return limited;

  try {
    const banks = await getBanks();
    return NextResponse.json({ success: true, banks });
  } catch (error: any) {
    console.error('[Monnify] banks route failed:', error.message);
    return NextResponse.json({ success: false, banks: [] }, { status: 500 });
  }
}
