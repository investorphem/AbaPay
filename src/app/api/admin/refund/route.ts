import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { verifyRefundOnChain, rememberRefundHash, refundHashAlreadyUsed } from '@/lib/refundVerify';

export async function POST(req: Request) {
  // 🔐 SECURITY: only the contract owner may mark transactions as refunded
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
  }

  try {
    const { id, refundHash, manualReason } = await req.json();

    if (!id || !refundHash) {
      return NextResponse.json({ success: false, message: "Missing transaction ID or refund hash" }, { status: 400 });
    }

    // Fetch the record we're about to mark refunded.
    const { data: record, error: fetchErr } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !record) {
      return NextResponse.json({ success: false, message: "Transaction record not found" }, { status: 404 });
    }

    // 🔴 MONEY-LOSS GUARD — server-side, not just the Ledger tab's button hiding/handleRefund
    // check. error_code REVERTED means the on-chain payBill/approve call itself reverted, so
    // the user's crypto never left their wallet, let alone reached the vault — there is
    // nothing to refund. A client-side-only guard is trivially bypassed (stale tab, direct API
    // call), and in fact already was: real vault payouts went out against REVERTED rows before
    // this check existed here. This is the same rule as refunds.ts's own header comment —
    // "refund on VEND failure, never on PAYMENT failure" — enforced at the one place that can't
    // be skipped.
    if (record.error_code === 'REVERTED') {
      return NextResponse.json({
        success: false,
        message: "This transaction's on-chain payment reverted — the user's crypto never reached the vault, so there is nothing to refund.",
      }, { status: 400 });
    }

    // 🔴 THE BUG THIS FIXES: this endpoint could mark ANY PENDING/PROCESSING row REFUNDED with
    // zero recorded reason — no error_code, no api_response — if a caller (the Ledger tab's
    // handleRefund, or a direct API call) never ran Check Status first. The refund itself still
    // completed correctly (verified on-chain below), but the ledger permanently lost WHY: no
    // way to later tell a Monnify failure from a VTpass rejection from an on-chain issue.
    // Require an explicit reason in exactly that gap — every other path (webhook, reconcile
    // sweep, Check Status) already sets one automatically before a row ever reaches here.
    const needsReason = !record.error_code && !record.api_response && (record.status === 'PENDING' || record.status === 'PROCESSING');
    if (needsReason && (!manualReason || typeof manualReason !== 'string' || !manualReason.trim())) {
      return NextResponse.json({
        success: false,
        message: "This transaction has no recorded failure reason. Run Check Status first, or supply a reason for this refund.",
      }, { status: 400 });
    }

    // 🔴 ONE PAYOUT CANNOT SETTLE TWO DEBTS. A retried bill produces two rows with the same
    // wallet, token and amount, and on-chain verification passes for BOTH against a single
    // payout — so the hash itself has to be checked for reuse. See refundHashAlreadyUsed.
    if (await refundHashAlreadyUsed(refundHash)) {
      return NextResponse.json({
        success: false,
        message: "That transaction is already recorded against another refund. One payout cannot settle two refunds — send a separate one for this transaction.",
      }, { status: 400 });
    }

    // 🔐 ON-CHAIN VERIFICATION (Audit v2, M-3)
    // Previously this endpoint flipped status to REFUNDED using an admin-supplied hash that
    // was NEVER checked against the chain — so a refund could be recorded that never actually
    // happened (accidentally or maliciously). We now confirm the refund transaction:
    //   (1) exists and succeeded on-chain,
    //   (2) transferred the record's token
    //   (3) TO the record's wallet
    //   (4) for at least the amount the user paid.
    //
    // Shared with the Ops-tab endpoint and the reconciliation sweep — see src/lib/refundVerify.ts
    // for why "not mined yet" is answered by WAITING and then remembering the hash, rather than
    // by rejecting a refund that is already on the network.
    const verdict = await verifyRefundOnChain({
      blockchain: record.blockchain,
      tokenUsed: record.token_used || 'USD₮',
      walletAddress: record.wallet_address,
      amountCrypto: record.amount_usdt,
      refundTxHash: refundHash,
    }, 60_000);

    if (verdict.status === 'REVERTED') {
      return NextResponse.json({ success: false, message: "Refund transaction failed or reverted on-chain — no funds moved, so it is safe to send again." }, { status: 400 });
    }

    if (verdict.status === 'MISMATCH') {
      return NextResponse.json({
        success: false,
        message: "Could not verify this refund on-chain (token, recipient, or amount did not match the transaction). Refund NOT recorded.",
      }, { status: 400 });
    }

    if (verdict.status === 'UNCONFIRMED') {
      // Broadcast, not yet mined. Park the hash on the queue row (if there is one) so the
      // sweep can finish it, and make it unmistakable that resending would pay twice.
      if (record.tx_hash) {
        const { data: queued } = await supabaseAdmin
          .from('refund_queue')
          .select('id')
          .eq('tx_hash', record.tx_hash)
          .eq('status', 'PENDING')
          .maybeSingle();
        if (queued) await rememberRefundHash((queued as any).id, refundHash, auth.address || 'admin');
      }
      console.warn('[Refund] hash recorded but unconfirmed:', refundHash, verdict.detail);
      return NextResponse.json({
        success: true,
        pending: true,
        message: "Refund broadcast but not yet confirmed on-chain. It has been saved and will be recorded automatically once it confirms — do NOT send it again.",
      });
    }

    // Verified — record it. Guard against double-refunding a record already marked REFUNDED.
    // When a manual reason was required above, persist it now so the ledger never ends up with
    // a REFUNDED row and zero explanation of why.
    const updatePayload: Record<string, any> = { status: 'REFUNDED', refund_hash: refundHash };
    if (needsReason) {
      updatePayload.error_code = 'MANUAL_ADMIN_REFUND';
      updatePayload.api_response = manualReason.trim();
    }
    const { data: updated, error } = await supabaseAdmin
      .from('transactions')
      .update(updatePayload)
      .eq('id', id)
      .neq('status', 'REFUNDED')
      .select();

    if (error) {
      console.error("Refund DB Update Error:", error.message);
      return NextResponse.json({ success: false, message: "Database error while recording refund." }, { status: 400 });
    }

    if (!updated || updated.length === 0) {
      return NextResponse.json({ success: true, message: "Transaction was already refunded." });
    }

    // ⚡ RECONCILE THE OPS QUEUE ⚡
    //
    // This is the OLDER of two refund paths (the Ledger tab's "Refund" button) — the newer
    // one (Ops tab, /api/admin/refunds) also marks refund_queue.status = 'COMPLETED' when it
    // records a refund. This endpoint never did, so a refund processed from the Ledger tab
    // left its refund_queue row stuck on PENDING forever — the Ops tab kept listing it as
    // still owed even though it had, in fact, been paid. Match by tx_hash (both tables key
    // refunds to the same failed-vend transaction) and complete it here too.
    if (record.tx_hash) {
      await supabaseAdmin
        .from('refund_queue')
        .update({
          status: 'COMPLETED',
          refund_tx_hash: refundHash,
          approved_by: auth.address || 'admin',
          approved_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          notes: 'Refunded via Ledger tab',
        })
        .eq('tx_hash', record.tx_hash)
        .eq('status', 'PENDING');
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Server Error:", error?.message);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
