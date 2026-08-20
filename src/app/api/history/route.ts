import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { verifyWalletSession } from '@/utils/walletAuth';

// ⚡ YOUR PAYMENT HISTORY, READ SERVER-SIDE, FOR A WALLET YOU HAVE PROVEN YOU HOLD
//
// 🔴 THE EXPOSURE THIS CLOSES. The History tab used to query Supabase STRAIGHT FROM THE BROWSER
// with the anon key:
//
//     supabase.from('transactions').select('*').ilike('wallet_address', address)
//
// The filter was the only thing scoping that read to the caller, and a filter written by the
// client is not a permission — swap the address and PostgREST returns someone else's rows. The
// table's policies made that worse rather than saving it: `SELECT USING (true)` for anon AND
// public, plus `INSERT WITH CHECK (true)` and `UPDATE USING (true)`, all against a key that
// ships in the browser bundle by design. Anyone could read every payment ever made — phone
// numbers, meter numbers, amounts, wallet addresses — and forge or rewrite rows outright.
//
// Two changes fix it, and both are needed. This route is one: the wallet address is taken from a
// SIGNATURE rather than from a query parameter, so the caller can only ever read the wallet they
// just proved they hold, and the query runs with the service-role client server-side. The other
// is migration 025, which drops those four policies — with them in place this route would be a
// locked front door beside an open window.
//
// Read-only by construction. Nothing here writes, and the session proof is not accepted anywhere
// that does: mutations keep their own five-minute, per-action signatures (verifyWalletOwnership).

export const dynamic = 'force-dynamic';

/** Six months, matching what the History tab has always shown. */
const HISTORY_MONTHS = 6;

export async function GET(req: Request) {
  const session = await verifyWalletSession(req);
  if (!session.ok) {
    return NextResponse.json({ error: session.message }, { status: 401 });
  }

  const since = new Date();
  since.setMonth(since.getMonth() - HISTORY_MONTHS);

  // 🔴 SCOPED TO THE VERIFIED ADDRESS, NOT TO ANYTHING THE CALLER SENT. This is the whole point
  // of the route — `session.address` came out of signature verification, so there is no input
  // here a caller could steer at someone else's records.
  //
  // The pre-flight and EXPIRED filters are carried over from the client query they replace: an
  // abandoned pre-flight intent (written before the wallet even signs) is not a payment and must
  // not appear as one. cleanupStalePreflights marks those EXPIRED rather than deleting them, so
  // nothing here can erase a real payment, which means excluding them has to happen on read.
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .ilike('wallet_address', session.address)
    .gte('created_at', since.toISOString())
    .not('tx_hash', 'like', 'preflight_%')
    .neq('status', 'EXPIRED')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[History] read failed:', error.message);
    return NextResponse.json({ error: 'Could not load your history right now.' }, { status: 500 });
  }

  return NextResponse.json({ transactions: data ?? [] });
}
