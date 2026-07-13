import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { getPublicClient, resolveChain } from '@/lib/chain';
import { resolveTokenOnChain } from '@/constants';
import { parseUnits, decodeEventLog } from 'viem';

// Minimal ERC-20 Transfer event ABI for verifying the refund on-chain.
const ERC20_TRANSFER_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
] as const;

export async function POST(req: Request) {
  // 🔐 SECURITY: only the contract owner may mark transactions as refunded
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
  }

  try {
    const { id, refundHash } = await req.json();

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

    // 🔐 ON-CHAIN VERIFICATION (Audit v2, M-3)
    // Previously this endpoint flipped status to REFUNDED using an admin-supplied hash that
    // was NEVER checked against the chain — so a refund could be recorded that never actually
    // happened (accidentally or maliciously). We now confirm the refund transaction:
    //   (1) exists and succeeded on-chain,
    //   (2) transferred the record's token
    //   (3) TO the record's wallet
    //   (4) for at least the amount the user paid.
    try {
      const publicClient = getPublicClient(record.blockchain);
      const receipt = await publicClient.getTransactionReceipt({ hash: refundHash as `0x${string}` });

      if (receipt.status !== 'success') {
        return NextResponse.json({ success: false, message: "Refund transaction failed or reverted on-chain." }, { status: 400 });
      }

      const { isMainnet } = resolveChain(record.blockchain);
      const expectedToken = resolveTokenOnChain(record.token_used || 'USD₮', record.blockchain || 'CELO', isMainnet);
      const recipient = (record.wallet_address || '').toLowerCase();

      // Find an ERC-20 Transfer in the refund tx that credits the user's wallet with the
      // expected token for at least the amount they paid (1-cent rounding grace).
      let verified = false;
      if (expectedToken && recipient) {
        const requiredWei = parseUnits(Number(record.amount_usdt).toFixed(expectedToken.decimals), expectedToken.decimals);
        const tolerance = parseUnits('0.01', expectedToken.decimals);

        for (const log of receipt.logs) {
          if (log.address?.toLowerCase() !== expectedToken.address) continue;
          try {
            const decoded: any = decodeEventLog({ abi: ERC20_TRANSFER_ABI, data: log.data, topics: log.topics });
            if (decoded.eventName !== 'Transfer') continue;
            if (String(decoded.args.to).toLowerCase() !== recipient) continue;
            const paid = BigInt(decoded.args.value);
            const shortfall = requiredWei > paid ? requiredWei - paid : BigInt(0);
            if (shortfall <= tolerance) { verified = true; break; }
          } catch { /* not a Transfer log */ }
        }
      }

      if (!verified) {
        return NextResponse.json({
          success: false,
          message: "Could not verify this refund on-chain (token, recipient, or amount did not match the transaction). Refund NOT recorded.",
        }, { status: 400 });
      }
    } catch (verifyErr: any) {
      console.error("Refund on-chain verification error:", verifyErr?.message);
      return NextResponse.json({ success: false, message: "Could not read the refund transaction from the blockchain. Please try again." }, { status: 400 });
    }

    // Verified — record it. Guard against double-refunding a record already marked REFUNDED.
    const { data: updated, error } = await supabaseAdmin
      .from('transactions')
      .update({ status: 'REFUNDED', refund_hash: refundHash })
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

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Server Error:", error?.message);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
