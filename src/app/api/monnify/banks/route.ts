import { NextResponse } from 'next/server';
import { getBanks } from '@/lib/monnify';
import { enforceRateLimit } from '@/lib/rateLimit';

// Same caching contract as /api/providers (VTpass): a cache miss here proxies a live Monnify
// call, so a fresh answer is cacheable at the edge, while a stale one (degraded to the
// last-known-good list or the offline seed) must not be — see getBanks() in src/lib/monnify.ts.
const CACHE_HEADER = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'monnify-banks', 30, 60);
  if (limited) return limited;

  try {
    const { banks, stale } = await getBanks();
    return NextResponse.json(
      { success: true, banks, stale },
      { headers: { 'Cache-Control': stale ? 'no-store' : CACHE_HEADER } }
    );
  } catch (error: any) {
    console.error('[Monnify] banks route failed:', error.message);
    return NextResponse.json({ success: false, banks: [], stale: true }, { status: 500 });
  }
}
