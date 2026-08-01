import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { buildReceiptEmail } from '@/lib/receiptEmail';
import { enqueueRefund } from '@/lib/refunds';
import { initiateTransfer, getTransferStatus } from '@/lib/monnify';
import type { VendInput, VendResult } from '@/lib/vend';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// ⚡ MONIEPOINT (VIA MONNIFY) BANK TRANSFER — the real payout rail for the "Transfer" tab.
//
// Mirrors executeVend()'s shape exactly (src/lib/vend.ts) so /api/pay's caller doesn't need
// to know which provider fulfilled the request — but the transfer itself is inherently
// asynchronous (Monnify's disbursement API answers "submitted", not "delivered", and confirms
// later via webhook), unlike VTpass's mostly-synchronous /pay. So this module never marks a
// row SUCCESS or FAILED_VENDING on the initiate call alone — only a definitive PENDING_
// AUTHORIZATION/SUCCESS/FAILED answer does that immediately; everything else stays PROCESSING
// and is finalized later by the webhook (src/app/api/monnify/webhook/route.ts) or the
// reconcile sweep (src/lib/reconcileStuck.ts), via finalizeMonnifyTransfer below.

/**
 * Called from executeVend() when serviceCategory === 'BANK'. Submits the transfer and
 * returns immediately — the row is left PROCESSING unless Monnify hands back a definitive
 * answer in the same response.
 */
export async function initiateMonnifyBankTransfer(input: VendInput): Promise<VendResult> {
  const { vtRequestId, txHash, billersCode, variation_code, vendAmount, network, customer_name } = input;

  if (!variation_code || !billersCode || !customer_name) {
    await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'MISSING_BANK_DETAILS' }).eq('tx_hash', txHash);
    return { success: false, status: 'FAILED_VENDING', message: 'Missing verified bank details — please re-verify the account and try again.' };
  }

  let result;
  try {
    result = await initiateTransfer({
      amount: vendAmount,
      reference: vtRequestId,
      narration: `AbaPay transfer to ${customer_name}`,
      destinationBankCode: variation_code,
      destinationAccountNumber: billersCode,
      destinationAccountName: customer_name,
    });
  } catch (e: any) {
    // Couldn't even reach Monnify — leave the lock and let the caller's TIMEOUT path retry
    // via the reconcile sweep, exactly like executeVend does when the VTpass fetch throws.
    await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash);
    return { success: true, status: 'TIMEOUT', message: 'Network slow. Finishing in background.' };
  }

  if (result.status === 'SUCCESS') {
    return finalizeMonnifyTransfer({ txHash, reference: vtRequestId, outcome: 'SUCCESS', raw: result.raw });
  }

  if (result.status === 'FAILED') {
    return finalizeMonnifyTransfer({ txHash, reference: vtRequestId, outcome: 'FAILED', raw: result.raw });
  }

  if (result.status === 'PENDING_AUTHORIZATION') {
    // MFA/OTP approval is turned on for this Monnify credential — the transfer will not move
    // until a human clicks the email approval link. That's incompatible with an unattended
    // flow; alert the operator loudly rather than leaving the user guessing.
    await sendTelegramAlert(
      `⚠️ *TRANSFER NEEDS MANUAL APPROVAL*\n\nMonnify is asking for OTP/email authorization on this disbursement — turn off transaction MFA for this API credential in the Moniepoint/Monnify dashboard to automate this.\n\n🛒 *Transfer:* ₦${vendAmount} to ${network} (${billersCode})\n👤 *User:* ${customer_name}\n🧾 *Ref:* ${vtRequestId}`
    );
    return { success: true, status: 'TIMEOUT', message: "Your transfer is awaiting authorization and may take a little longer than usual — we'll notify you once it completes." };
  }

  // PENDING / IN_PROGRESS — the normal async case. Row stays PROCESSING; webhook or the
  // reconcile sweep finishes it.
  return { success: true, status: 'TIMEOUT', message: 'Transfer submitted — you will be notified once it completes.' };
}

export interface FinalizeParams {
  txHash: string;
  reference: string;
  outcome: 'SUCCESS' | 'FAILED';
  raw?: any;
  failureReason?: string;
}

/**
 * Shared finalization for a Monnify transfer outcome — used by the initiate call above
 * (when Monnify answers synchronously), the webhook, AND the reconcile sweep. All three
 * funnel through here so there is exactly one success/failure side-effect implementation.
 *
 * Atomic claim: only the first caller to transition the row off PROCESSING/PENDING acts —
 * guards against the webhook and reconcile sweep racing each other.
 */
export async function finalizeMonnifyTransfer(p: FinalizeParams): Promise<VendResult> {
  const { data: record } = await supabase.from('transactions').select('*').eq('tx_hash', p.txHash).single();
  if (!record) return { success: false, status: 'FAILED_VENDING', message: 'Transaction record not found.' };

  if (record.status === 'SUCCESS' || record.status === 'FAILED_VENDING') {
    // Already resolved by another caller (webhook vs. sweep race, or a retry).
    return { success: record.status === 'SUCCESS', status: record.status, request_id: record.request_id };
  }

  if (p.outcome === 'SUCCESS') {
    const { data: claimed } = await supabase
      .from('transactions')
      .update({ status: 'SUCCESS' })
      .eq('tx_hash', p.txHash)
      .in('status', ['PROCESSING', 'PENDING'])
      .select();

    if (!claimed || claimed.length === 0) return { success: true, status: 'SUCCESS', request_id: record.request_id };

    try {
      await sendTelegramAlert(
        `✅ *TRANSFER SUCCESSFUL*\n💰 *Amount:* ₦${record.amount_naira}\n🏦 *Bank:* ${record.network}\n👤 *Account:* ${record.account_number} (${record.customer_name || 'Unverified'})\n🧾 *Ref:* ${record.request_id}\n🔗 \`${record.tx_hash}\``
      );
    } catch {}

    if (record.customer_email) {
      const html = buildReceiptEmail({
        displayAmount: record.display_amount || `₦${Number(record.amount_naira).toLocaleString()}`,
        serviceLabel: `${record.network || 'Bank'} Transfer`,
        accountNumber: record.account_number,
        cryptoCharged: `${record.amount_usdt} ${record.token_used || 'USD₮'}`,
        txHash: record.tx_hash,
        referenceId: record.request_id,
        customerName: record.customer_name,
        bankName: record.network,
      });
      try {
        await resend.emails.send({
          from: 'AbaPay Receipts <receipts@abapays.com>',
          to: record.customer_email,
          replyTo: 'support@abapays.com',
          subject: `AbaPay Receipt - ${record.network} Transfer`,
          html,
        });
      } catch (e) { console.error('[Monnify] Receipt email failed:', e); }
    }

    const rate = process.env.NEXT_PUBLIC_FIXED_RATE ? Number(process.env.NEXT_PUBLIC_FIXED_RATE) : (Number(record.amount_naira) / (Number(record.amount_usdt) || 1));
    const points = Number.isFinite(rate) && rate > 0 ? Number((Number(record.amount_naira) / rate).toFixed(2)) : 0;
    if (points > 0 && record.wallet_address) {
      supabase.rpc('award_transaction_points', { target_wallet: record.wallet_address.toLowerCase(), points_to_add: points }).then(({ error }: any) => {
        if (error) console.error('[Monnify] Points error:', error.message);
      });
    }

    return { success: true, status: 'SUCCESS', request_id: record.request_id };
  }

  // FAILED
  const { data: claimed } = await supabase
    .from('transactions')
    .update({ status: 'FAILED_VENDING', error_code: 'MONNIFY_FAILED', api_response: p.failureReason || 'Monnify transfer failed' })
    .eq('tx_hash', p.txHash)
    .in('status', ['PROCESSING', 'PENDING'])
    .select();

  if (!claimed || claimed.length === 0) return { success: false, status: 'FAILED_VENDING', request_id: record.request_id };

  try {
    await sendTelegramAlert(
      `❌ *TRANSFER FAILED*\n💰 *Amount:* ₦${record.amount_naira}\n🏦 *Bank:* ${record.network}\n👤 *Account:* ${record.account_number}\n🚨 *Reason:* ${p.failureReason || 'Monnify rejected the transfer'}\n🔗 \`${record.tx_hash}\`\nFunds are being refunded automatically.`
    );
  } catch {}

  try {
    await enqueueRefund({
      transactionId: record.id,
      txHash: record.tx_hash,
      walletAddress: record.wallet_address || '',
      tokenUsed: record.token_used || 'USD₮',
      amountCrypto: Number(record.amount_usdt),
      amountNaira: Number(record.amount_naira),
      blockchain: record.blockchain || 'CELO',
      reason: 'Monnify transfer rejected',
      vtpassError: p.failureReason || 'Monnify transfer failed',
      serviceCategory: record.service_category,
      sourceChannel: record.source_channel || 'WEB',
    });
  } catch (e) {
    console.error('[Monnify] Failed to queue refund:', e);
  }

  return { success: false, status: 'FAILED_VENDING', message: "The transfer couldn't be completed. Your funds are being refunded — you don't need to do anything." };
}

/**
 * Used by the reconcile sweep for a stuck BANK row: ask Monnify for the real status of a
 * reference we already submitted, read-only, no side effects.
 */
export async function requeryMonnifyTransfer(reference: string) {
  return getTransferStatus(reference);
}
