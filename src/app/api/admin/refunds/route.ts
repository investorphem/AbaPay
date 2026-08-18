import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { verifyRefundOnChain, completeRefund, rememberRefundHash, refundHashAlreadyUsed } from '@/lib/refundVerify';

// ⚡ ADMIN: REFUND QUEUE
//
// Failed vends are auto-enqueued (see src/lib/refunds.ts). The operator reviews them here
// and executes the refund from THEIR OWN wallet — the browser signs refundUser() on-chain,
// then posts the hash back here where we VERIFY it before marking the refund complete.
//
// WHY THE HUMAN STAYS IN THE LOOP: refundUser() is onlyOwner by design. Handing the relayer
// hot key the power to send vault funds to arbitrary addresses would turn a bounded, capped
// key into one that can drain the treasury. Money ENTERING the vault (payBillFor) is capped
// on-chain and safe to automate. Money LEAVING it is not. That asymmetry is deliberate.

export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') || 'PENDING';

  const { data, error } = await supabaseAdmin
    .from('refund_queue')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ success: false, message: 'Could not load refunds.' }, { status: 500 });
  }

  // Totals so the operator can see the liability at a glance.
  const { data: pending } = await supabaseAdmin
    .from('refund_queue')
    .select('amount_naira, amount_crypto, token_used')
    .eq('status', 'PENDING');

  const owed = (pending || []).reduce((sum: number, r: any) => sum + Number(r.amount_naira || 0), 0);

  return NextResponse.json({
    success: true,
    refunds: data || [],
    summary: { pendingCount: (pending || []).length, totalOwedNgn: owed },
  });
}

/**
 * Record a completed refund. The admin's wallet has already signed refundUser() on-chain;
 * we verify that transaction before trusting it.
 */
export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  try {
    const { id, refund_tx_hash, action, notes } = await req.json();

    if (!id) return NextResponse.json({ success: false, message: 'Refund id required' }, { status: 400 });

    const { data: refund } = await supabaseAdmin.from('refund_queue').select('*').eq('id', id).single();
    if (!refund) return NextResponse.json({ success: false, message: 'Refund not found' }, { status: 404 });

    // Operator explicitly rejects (e.g. the vend actually succeeded on retry).
    if (action === 'REJECT') {
      await supabaseAdmin.from('refund_queue').update({
        status: 'REJECTED',
        approved_by: auth.address || 'admin',
        approved_at: new Date().toISOString(),
        notes: notes || 'Rejected by operator',
      }).eq('id', id);
      return NextResponse.json({ success: true, message: 'Refund rejected.' });
    }

    if (!refund_tx_hash) {
      return NextResponse.json({ success: false, message: 'Refund transaction hash required' }, { status: 400 });
    }

    // 🔴 ONE PAYOUT CANNOT SETTLE TWO DEBTS. A retried bill leaves two queue rows with the same
    // wallet, token and amount, so on-chain verification passes for BOTH against a single
    // payout — see refundHashAlreadyUsed.
    if (await refundHashAlreadyUsed(refund_tx_hash, id)) {
      return NextResponse.json({
        success: false,
        message: 'That transaction is already recorded against another refund. One payout cannot settle two refunds — send a separate one for this row.',
      }, { status: 400 });
    }

    // 🔐 VERIFY THE REFUND ON-CHAIN before we mark anyone as paid.
    // Without this, a careless or malicious admin could mark refunds that never happened.
    //
    // 🔴 BUT "NOT MINED YET" IS NOT "NOT VALID". The Ops tab posts this hash the moment the
    // wallet broadcasts it — see AdminOpsPanel.doRefund — so the transaction is normally still
    // in the mempool when we get here. Waiting for the receipt (rather than demanding one
    // already exists) turns the common case from a hard failure into a short pause, and any
    // hash we still can't confirm is KEPT on the row for the sweep to finish. Losing it was
    // how refunds ended up paid on-chain and still showing as owed. See src/lib/refundVerify.ts.
    const verdict = await verifyRefundOnChain({
      blockchain: refund.blockchain,
      tokenUsed: refund.token_used,
      walletAddress: refund.wallet_address,
      amountCrypto: refund.amount_crypto,
      refundTxHash: refund_tx_hash,
    }, 60_000);

    if (verdict.status === 'REVERTED') {
      return NextResponse.json({ success: false, message: 'That refund transaction failed on-chain — no funds moved, so it is safe to send again.' }, { status: 400 });
    }

    if (verdict.status === 'MISMATCH') {
      return NextResponse.json({
        success: false,
        message: 'Could not verify that refund on-chain (recipient, token, or amount did not match). NOT recorded.',
      }, { status: 400 });
    }

    if (verdict.status === 'UNCONFIRMED') {
      // The money may well be moving right now. Remember the hash against this row so the
      // reconciliation sweep completes it automatically, and tell the operator NOT to resend.
      await rememberRefundHash(id, refund_tx_hash, auth.address || 'admin');
      console.warn('[Refund] hash recorded but unconfirmed:', refund_tx_hash, verdict.detail);
      return NextResponse.json({
        success: true,
        pending: true,
        message: 'Refund broadcast but not yet confirmed on-chain. It has been saved against this refund and will be marked complete automatically once it confirms — do NOT send it again.',
      });
    }

    // Verified — complete it, notify the user, and keep the ledger in step.
    const done = await completeRefund(refund, refund_tx_hash, { approvedBy: auth.address || 'admin', notes: notes || null });

    return NextResponse.json({
      success: true,
      message: done ? 'Refund verified and recorded.' : 'This refund was already recorded.',
    });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
