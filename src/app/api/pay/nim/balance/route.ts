import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isNimAddress, nimBalanceLuna } from '@/lib/nimiq';

// ⚡ A Nimiq address's balance, read from the Nimiq chain (src/lib/nimiq.ts nimBalanceLuna).
//
// The mini app shows THIS, not the host's getBalance: in Nimiq Pay that read came back 0 for
// funded wallets (2026-10-17, still after waiting for consensus), so the header said "0 NIM ·
// $0.0000". Balances on Nimiq are public chain data, so this needs no signature; it is
// rate-limited like the other NIM endpoints and never cached.
export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'nim_balance', 30, 60);
  if (limited) return limited;

  const address = new URL(req.url).searchParams.get('address') || '';
  if (!isNimAddress(address)) {
    return NextResponse.json({ balance_luna: null, error: 'Not a valid Nimiq address.' }, { status: 400 });
  }
  const balanceLuna = await nimBalanceLuna(address);
  return NextResponse.json({ balance_luna: balanceLuna }, { headers: { 'Cache-Control': 'no-store' } });
}
