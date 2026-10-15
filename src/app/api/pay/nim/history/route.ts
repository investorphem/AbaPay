import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';
import { verifyNimSession } from '@/lib/nimiqAuth';

// ⚡ NIM ORDER HISTORY — the mini app's History tab. Same rule as /api/history for wallets: the
// address comes out of a signature (src/lib/nimiqAuth.ts), never from a parameter, so a caller
// can only ever read the orders of the Nimiq address they just proved they hold. Read-only.

export const dynamic = 'force-dynamic';

const HISTORY_MONTHS = 6;

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'nim_history', 30, 60);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const session = verifyNimSession(body);
  if (!session.ok) return NextResponse.json({ error: session.message }, { status: 401 });

  const since = new Date();
  since.setMonth(since.getMonth() - HISTORY_MONTHS);

  // Unpaid orders (still a preflight_nim_ placeholder) and expired ones aren't payments.
  const { data, error } = await supabase
    .from('transactions')
    .select('created_at, status, service_category, service_id, network, account_number, amount_naira, display_amount, amount_usdt, token_used, tx_hash, request_id, purchased_code, units, error_code')
    .eq('blockchain', 'NIMIQ')
    .eq('wallet_address', session.address)
    .gte('created_at', since.toISOString())
    .not('tx_hash', 'like', 'preflight_%')
    .neq('status', 'EXPIRED')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[NIM history] read failed:', error.message);
    return NextResponse.json({ error: 'Could not load your history right now.' }, { status: 500 });
  }
  return NextResponse.json({ address: session.address, transactions: data ?? [] });
}
