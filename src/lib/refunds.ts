import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert, sendTelegramToUser } from '@/lib/telegram';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// ⚡ REFUND PIPELINE
//
// When VTpass fails AFTER we've taken the user's crypto, the money is in our vault and the
// user got nothing. This makes that recoverable — automatically detected, operator-approved,
// on-chain verified, and the user is told on the channel they actually used.
//
// 🔴 THE MOST IMPORTANT RULE IN THIS FILE:
// Only enqueue a refund when the funds were ACTUALLY RECEIVED on-chain. If the blockchain
// transaction reverted, or the payment never landed, the user still HAS their money — and
// "refunding" them would be paying them out of the treasury for nothing. That is a free
// money bug. We therefore refund on VEND failure, never on PAYMENT failure.

export interface EnqueueParams {
  txHash: string;
  walletAddress: string;
  tokenUsed: string;
  amountCrypto: number;
  amountNaira?: number;
  blockchain?: string;
  reason: string;
  vtpassError?: string;
  serviceCategory?: string;
  sourceChannel?: string;
  transactionId?: string;
}

/**
 * Queue a refund for a vend that failed AFTER the user's funds reached our vault.
 *
 * Idempotent: tx_hash is unique, so a retrying webhook can't enqueue the same refund twice.
 */
export async function enqueueRefund(p: EnqueueParams): Promise<{ queued: boolean; reason?: string }> {
  try {
    if (!p.txHash || !p.walletAddress || !p.amountCrypto || p.amountCrypto <= 0) {
      return { queued: false, reason: 'Insufficient data to queue a refund.' };
    }

    // Never refund a preflight — no funds ever moved.
    if (p.txHash.startsWith('preflight_')) {
      return { queued: false, reason: 'No on-chain payment was made — nothing to refund.' };
    }

    const { error } = await supabaseAdmin.from('refund_queue').insert({
      transaction_id: p.transactionId || null,
      tx_hash: p.txHash,
      wallet_address: p.walletAddress.toLowerCase(),
      token_used: p.tokenUsed,
      amount_crypto: p.amountCrypto,
      amount_naira: p.amountNaira ?? null,
      blockchain: p.blockchain || 'CELO',
      reason: p.reason,
      vtpass_error: p.vtpassError || null,
      service_category: p.serviceCategory || null,
      source_channel: p.sourceChannel || 'WEB',
      status: 'PENDING',
    });

    // A duplicate is fine — it means we already queued this one.
    if (error) {
      if (error.code === '23505') return { queued: false, reason: 'Already queued.' };
      console.error('[Refund] enqueue failed:', error.message);
      return { queued: false, reason: error.message };
    }

    // Alert the operator immediately — someone is owed money.
    try {
      const via = String(p.sourceChannel || 'WEB').toUpperCase();
      await sendTelegramAlert(
        `💸 *REFUND QUEUED*\n` +
        `📲 *Source:* ${via === 'SCHEDULE' ? '🤖 Autonomous Schedule' : via === 'WEB' ? '🌐 Web App' : `💬 ${via} Agent`}\n` +
        `🛒 *Service:* ${p.serviceCategory || 'N/A'}\n` +
        `💰 *Owed:* ${p.amountCrypto} ${p.tokenUsed}${p.amountNaira ? ` (₦${p.amountNaira.toLocaleString()})` : ''}\n` +
        `👤 *Wallet:* \`${p.walletAddress.slice(0, 6)}...${p.walletAddress.slice(-4)}\`\n` +
        `🚨 *Reason:* ${p.vtpassError || p.reason}\n` +
        `🔗 \`${p.txHash}\`\n\n` +
        `_Approve it in Admin → Refunds._`
      );
    } catch { /* alerting must never block the queue write */ }

    // Tell the user straight away. Silence after a failed payment is what destroys trust.
    await notifyUserOfPendingRefund(p);

    return { queued: true };
  } catch (err) {
    console.error('[Refund] enqueue error:', err);
    return { queued: false, reason: 'Internal error' };
  }
}

/**
 * Tell the user their payment failed and a refund is coming — on whichever channel they
 * actually used. A user who paid via Telegram should hear about it in Telegram.
 */
async function notifyUserOfPendingRefund(p: EnqueueParams) {
  const amount = p.amountNaira ? `₦${p.amountNaira.toLocaleString()}` : `${p.amountCrypto} ${p.tokenUsed}`;
  const msg =
    `⚠️ *Your ${p.serviceCategory || ''} payment didn't go through.*\n\n` +
    `${p.vtpassError || 'The provider could not complete it.'}\n\n` +
    `💰 *${amount}* is being refunded to your wallet. You'll get a confirmation as soon as it's sent.\n\n` +
    `_You don't need to do anything._`;

  try {
    // Find their linked chat, if any.
    const { data: link } = await supabaseAdmin
      .from('agent_links')
      .select('channel, channel_user_id')
      .ilike('wallet_address', p.walletAddress)
      .eq('link_verified', true)
      .maybeSingle();

    if (link && (link as any).channel === 'TELEGRAM') {
      await sendTelegramToUser((link as any).channel_user_id, msg);
    }
  } catch { /* best-effort */ }

  // Email, if we have one on the transaction.
  try {
    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('customer_email')
      .eq('tx_hash', p.txHash)
      .maybeSingle();

    const email = (tx as any)?.customer_email;
    if (email) {
      await resend.emails.send({
        from: 'AbaPay <receipts@abapays.com>',
        to: email,
        replyTo: 'support@abapays.com',
        subject: 'Your AbaPay payment failed — refund on the way',
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;">
          <h2 style="margin:0 0 12px;">⚠️ Payment couldn't be completed</h2>
          <p style="color:#334155;">${p.vtpassError || 'Our provider could not complete your payment.'}</p>
          <p style="color:#334155;"><strong>${amount}</strong> is being refunded to your wallet. You'll receive a confirmation once it's sent.</p>
          <p style="color:#64748b;font-size:13px;">You don't need to do anything. Reply to this email if you have any questions.</p>
        </div>`,
      });
    }
  } catch { /* best-effort */ }
}

/**
 * Confirm to the user that their refund has actually landed on-chain.
 */
export async function notifyUserRefundCompleted(refund: any, refundTxHash: string) {
  const amount = refund.amount_naira
    ? `₦${Number(refund.amount_naira).toLocaleString()}`
    : `${refund.amount_crypto} ${refund.token_used}`;

  const msg =
    `✅ *Refund sent!*\n\n` +
    `💰 *${amount}* is back in your wallet.\n` +
    `🔗 \`${refundTxHash}\`\n\n` +
    `Sorry about that — thanks for your patience.`;

  try {
    const { data: link } = await supabaseAdmin
      .from('agent_links')
      .select('channel, channel_user_id')
      .ilike('wallet_address', refund.wallet_address)
      .eq('link_verified', true)
      .maybeSingle();

    if (link && (link as any).channel === 'TELEGRAM') {
      await sendTelegramToUser((link as any).channel_user_id, msg);
    }
  } catch { /* best-effort */ }

  try {
    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('customer_email')
      .eq('tx_hash', refund.tx_hash)
      .maybeSingle();

    const email = (tx as any)?.customer_email;
    if (email) {
      await resend.emails.send({
        from: 'AbaPay <receipts@abapays.com>',
        to: email,
        replyTo: 'support@abapays.com',
        subject: 'Your AbaPay refund has been sent',
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;">
          <h2 style="margin:0 0 12px;">✅ Refund sent</h2>
          <p style="color:#334155;"><strong>${amount}</strong> is back in your wallet.</p>
          <p style="color:#64748b;font-size:12px;font-family:monospace;">${refundTxHash}</p>
          <p style="color:#64748b;font-size:13px;">Sorry about that — thanks for your patience.</p>
        </div>`,
      });
    }
  } catch { /* best-effort */ }

  await supabaseAdmin.from('refund_queue').update({ user_notified: true }).eq('id', refund.id);
}
