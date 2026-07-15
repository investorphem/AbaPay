import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { notifyUserRefundCompleted } from '@/lib/refunds';
import { getPublicClient, resolveChain } from '@/lib/chain';
import { resolveTokenOnChain } from '@/constants';
import { parseUnits, decodeEventLog } from 'viem';

const ERC20_TRANSFER_ABI = [{
  anonymous: false,
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
  name: 'Transfer',
  type: 'event',
}] as const;

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

    // 🔐 VERIFY THE REFUND ON-CHAIN before we mark anyone as paid.
    // Without this, a careless or malicious admin could mark refunds that never happened.
    try {
      const client = getPublicClient(refund.blockchain);
      const receipt = await client.getTransactionReceipt({ hash: refund_tx_hash as `0x${string}` });

      if (receipt.status !== 'success') {
        return NextResponse.json({ success: false, message: 'That refund transaction failed on-chain.' }, { status: 400 });
      }

      const { isMainnet } = resolveChain(refund.blockchain);
      const token = resolveTokenOnChain(refund.token_used, refund.blockchain, isMainnet);
      const recipient = String(refund.wallet_address).toLowerCase();

      let verified = false;
      if (token) {
        const requiredWei = parseUnits(Number(refund.amount_crypto).toFixed(token.decimals), token.decimals);
        const tolerance = parseUnits('0.01', token.decimals);

        for (const log of receipt.logs) {
          if (log.address?.toLowerCase() !== token.address) continue;
          try {
            const d: any = decodeEventLog({ abi: ERC20_TRANSFER_ABI, data: log.data, topics: log.topics });
            if (d.eventName !== 'Transfer') continue;
            if (String(d.args.to).toLowerCase() !== recipient) continue;
            const paid = BigInt(d.args.value);
            const shortfall = requiredWei > paid ? requiredWei - paid : BigInt(0);
            if (shortfall <= tolerance) { verified = true; break; }
          } catch { /* not a Transfer log */ }
        }
      }

      if (!verified) {
        return NextResponse.json({
          success: false,
          message: 'Could not verify that refund on-chain (recipient, token, or amount did not match). NOT recorded.',
        }, { status: 400 });
      }
    } catch (err: any) {
      console.error('[Refund] verification error:', err?.message);
      return NextResponse.json({ success: false, message: 'Could not read that refund transaction from the blockchain.' }, { status: 400 });
    }

    // Verified — complete it.
    await supabaseAdmin.from('refund_queue').update({
      status: 'COMPLETED',
      refund_tx_hash,
      approved_by: auth.address || 'admin',
      approved_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      notes: notes || null,
    }).eq('id', id);

    // Keep the transaction ledger in step.
    await supabaseAdmin.from('transactions')
      .update({ status: 'REFUNDED', refund_hash: refund_tx_hash })
      .eq('tx_hash', refund.tx_hash);

    // Tell the user, on the channel they actually used.
    try { await notifyUserRefundCompleted(refund, refund_tx_hash); } catch { /* best-effort */ }

    return NextResponse.json({ success: true, message: 'Refund verified and recorded.' });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
