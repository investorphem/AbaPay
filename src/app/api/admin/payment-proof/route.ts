import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { proveOrderPaid } from '@/lib/orderPaymentProof';
import { errorMessage } from '@/lib/errors';

export const dynamic = 'force-dynamic';

// GET /api/admin/payment-proof?id=<transaction id>
// Proves a Celo/Base order's ORIGINAL payment on chain (src/lib/orderPaymentProof.ts). The ledger's
// Refund asks this before any vault payout. Admin only.
export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: auth.message }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return NextResponse.json({ success: false, message: 'Transaction id required' }, { status: 400 });

  const { data: row } = await supabaseAdmin
    .from('transactions')
    .select('blockchain, status, error_code, payment_method, tx_hash, x402_settle_tx, x402_payer, wallet_address, token_used, amount_usdt, account_number, service_id')
    .eq('id', id)
    .maybeSingle();
  if (!row) return NextResponse.json({ success: false, message: 'Transaction not found' }, { status: 404 });

  try {
    const verdict = await proveOrderPaid(row);
    return NextResponse.json({ success: true, ...verdict }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ success: true, status: 'UNDECIDED', detail: errorMessage(e) }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
