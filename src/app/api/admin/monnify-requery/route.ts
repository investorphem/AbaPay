import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requeryMonnifyTransfer, finalizeMonnifyTransfer } from '@/lib/monnifyVend';

// ⚡ Admin-triggered "Check Status" for a BANK transfer — the Monnify equivalent of
// /api/requery (VTpass). Kept as its own route rather than branching inside /api/requery
// because the two providers' status shapes and finalize paths are entirely different; forcing
// them through one endpoint would just mean an if/else on service_category duplicating most
// of this file anyway.
export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
  }

  const limited = await enforceRateLimit(req, 'monnify-requery', 30, 60);
  if (limited) return limited;

  try {
    const { request_id, tx_hash } = await req.json();
    if (!request_id || !tx_hash) {
      return NextResponse.json({ success: false, message: 'Missing request_id or tx_hash' }, { status: 400 });
    }

    const { data: record } = await supabase.from('transactions').select('*').eq('tx_hash', tx_hash).single();
    if (!record || record.request_id !== request_id || record.service_category !== 'BANK') {
      return NextResponse.json({ success: false, message: 'Transaction record not found' }, { status: 404 });
    }

    if (record.status === 'SUCCESS' || record.status === 'FAILED_VENDING' || record.status === 'REFUNDED') {
      return NextResponse.json({ success: true, status: record.status, message: 'Already resolved.' });
    }

    const monnifyStatus = await requeryMonnifyTransfer(record.request_id);

    if (!monnifyStatus) {
      return NextResponse.json({
        success: true,
        status: 'PENDING',
        noRecord: true,
        message: "Monnify has no record of this reference — the transfer was never actually submitted to them. This needs a manual retry or refund; it will not resolve on its own.",
      });
    }

    if (monnifyStatus.status === 'SUCCESS') {
      await finalizeMonnifyTransfer({ txHash: record.tx_hash, reference: record.request_id, outcome: 'SUCCESS', raw: monnifyStatus.raw });
      return NextResponse.json({ success: true, status: 'SUCCESS' });
    }

    if (monnifyStatus.status === 'FAILED') {
      await finalizeMonnifyTransfer({ txHash: record.tx_hash, reference: record.request_id, outcome: 'FAILED', raw: monnifyStatus.raw, failureReason: 'Monnify confirmed failure via admin-triggered requery' });
      return NextResponse.json({ success: true, status: 'FAILED_VENDING' });
    }

    // PENDING / PENDING_AUTHORIZATION / IN_PROGRESS — genuinely still processing at Monnify.
    return NextResponse.json({ success: true, status: 'PENDING', message: `Monnify reports: ${monnifyStatus.status}. Still processing.` });
  } catch (error: any) {
    console.error('[Admin] Monnify requery failed:', error.message);
    return NextResponse.json({ success: false, message: 'Server error while querying status' }, { status: 500 });
  }
}
