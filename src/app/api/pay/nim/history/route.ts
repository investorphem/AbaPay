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

  // Every order, including ones still waiting for their NIM (a preflight_nim_ placeholder) and
  // expired ones: when Nimiq Pay holds a send as "pending", the customer must be able to see the
  // order is waiting, and later that it expired with nothing charged (or that a late payment is
  // being refunded). The placeholder itself is internal, so it isn't returned (tx_hash: null).
  const { data, error } = await supabase
    .from('transactions')
    .select('created_at, status, service_category, service_id, network, account_number, amount_naira, display_amount, amount_usdt, token_used, discount_ngn, discount_percent, tx_hash, request_id, purchased_code, units, error_code')
    .eq('blockchain', 'NIMIQ')
    .eq('wallet_address', session.address)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[NIM history] read failed:', error.message);
    return NextResponse.json({ error: 'Could not load your history right now.' }, { status: 500 });
  }
  const transactions = (data ?? []).map((t) => (String(t.tx_hash || '').startsWith('preflight_') ? { ...t, tx_hash: null } : t));
  return NextResponse.json({ address: session.address, transactions });
}
