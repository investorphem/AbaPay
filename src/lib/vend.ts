import 'server-only';
import crypto from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass';
import { buildReceiptEmail } from '@/lib/receiptEmail';
import { enqueueRefund } from '@/lib/refunds';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// 🔐 SECURITY: request_id is the lookup key for a transaction's `purchased_code`
// (electricity token / exam PIN — a bearer secret). It MUST NOT be predictable.
// crypto.randomInt() is a CSPRNG and unbiased. 12 chars over a 36-char alphabet
// = 36^12 ≈ 4.7e18 — not brute-forceable.
//
// NOTE: this duplicates generateRequestId() in src/lib/vtpass.js. Both are now secure,
// but the duplication should be removed (see AUDIT_REPORT_V2.md, item M-2 / #7).
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function getStrictRequestId(): string {
  const date = new Date();
  const lagosTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const [datePart, timePart] = lagosTime.split(', ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute] = timePart.split(':');
  const safeHour = hour === '24' ? '00' : hour;

  let randomString = '';
  for (let i = 0; i < 12; i++) {
    randomString += ID_ALPHABET[crypto.randomInt(0, ID_ALPHABET.length)];
  }

  return `${year}${month}${day}${safeHour}${minute}${randomString}`;
}

const error_messages: Record<string, string> = {
  '011': 'Invalid details. Check your phone/meter number.',
  '014': 'Daily limit exceeded with this provider.',
  '016': 'Provider network is unstable. Please try again.',
  '018': 'Service temporarily unavailable.',
  '030': 'Provider network is down.',
  '400': 'Transaction failed due to a system error.',
};

// ⚡ Where did this transaction come from? Operators need to distinguish a web payment
// from an agent payment from an unattended autonomous schedule — very different risk.
function channelBadge(src: string | null | undefined): string {
  switch (String(src || 'WEB').toUpperCase()) {
    case 'TELEGRAM': return '💬 Telegram Agent';
    case 'WHATSAPP': return '💬 WhatsApp Agent';
    case 'X':        return '💬 X Agent';
    case 'SCHEDULE': return '🤖 Autonomous Schedule';
    default:         return '🌐 Web App';
  }
}

export interface VendInput {
  vtRequestId: string;
  txHash: string;
  serviceID: string;
  serviceCategory: string;
  network: string;
  billersCode: string;
  phone?: string | null;
  variation_code?: string;
  subscription_type?: string;
  amount: number | string;          // crypto quantity charged (e.g. "5.00")
  tokenSymbol?: string;
  vendAmount: number;                // naira amount
  displayAmount?: string;
  foreignAmount?: string | number;
  isForeign: boolean;
  operator_id?: string | number;
  country_code?: string;
  product_type_id?: string | number;
  email?: string | null;
  wallet_address?: string;
  blockchain?: string;
  source_channel?: string;
  customer_name?: string | null;
  customer_address?: string | null;
  baseRate: number;
  explorerUrl: string;
}

export interface VendResult {
  success: boolean;
  status: 'SUCCESS' | 'FAILED_VENDING' | 'TIMEOUT';
  purchased_code?: string | null;
  units?: string | null;
  request_id?: string;
  message?: string;
}

/**
 * Calls VTpass to actually deliver the paid-for service, then records the outcome —
 * success (notify + points) or failure (queue a refund, since funds already landed
 * on-chain by the time this runs). Shared by both settlement rails: the on-chain
 * contract-call path (`/api/pay`) and the x402 path (`/api/pay/x402`) — a payment
 * verified through either rail ends up here, so there is exactly one vend/refund
 * implementation to keep correct.
 */
export async function executeVend(input: VendInput): Promise<VendResult> {
  const {
    vtRequestId, txHash, serviceID, serviceCategory, network, billersCode, phone,
    variation_code, subscription_type, amount, tokenSymbol, vendAmount, displayAmount,
    foreignAmount, isForeign, operator_id, country_code, product_type_id, email,
    wallet_address, blockchain, source_channel, customer_name, customer_address,
    baseRate, explorerUrl,
  } = input;

  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';

  const safeAmount = isForeign ? parseFloat(String(foreignAmount || '1')) : vendAmount;
  const safePhone = isForeign ? '08168811821' : (phone || billersCode);

  let vtpassPayload: any = {
    request_id: vtRequestId,
    serviceID: serviceID,
    amount: safeAmount,
    phone: safePhone,
  };

  if (isForeign) {
    vtpassPayload.billersCode = billersCode;
    vtpassPayload.variation_code = variation_code;
    vtpassPayload.operator_id = operator_id?.toString();
    vtpassPayload.country_code = country_code;
    vtpassPayload.product_type_id = product_type_id?.toString();
    vtpassPayload.email = email || 'support@abapay.com';
  } else {
    if (['DATA', 'ELECTRICITY', 'BANK'].includes(serviceCategory)) {
      vtpassPayload.billersCode = billersCode; vtpassPayload.variation_code = variation_code;
    } else if (serviceCategory === 'EDUCATION') {
      vtpassPayload.variation_code = variation_code; if (serviceID === 'jamb') vtpassPayload.billersCode = billersCode;
    } else if (serviceCategory === 'INTERNET') {
      vtpassPayload.billersCode = billersCode; vtpassPayload.variation_code = variation_code; if (serviceID === 'spectranet') vtpassPayload.quantity = 1;
    } else if (serviceCategory === 'CABLE') {
      vtpassPayload.billersCode = billersCode;
      if (['dstv', 'gotv'].includes(serviceID)) {
        vtpassPayload.subscription_type = subscription_type;
        if (subscription_type === 'change') { vtpassPayload.variation_code = variation_code; vtpassPayload.quantity = 1; }
      } else {
        vtpassPayload.variation_code = variation_code;
      }
    }
  }

  let payRes, payData;
  try {
    payRes = await fetch(`${baseUrl}/pay`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(vtpassPayload) });
    payData = await payRes.json();
  } catch (e: any) {
    await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash);
    return { success: true, status: 'TIMEOUT', message: 'Network slow. Finishing in background.' };
  }

  if (payData.code === '000' || payData.code === '099') {
    let dbPurchasedCode = null; let vendedUnits = null; let alertTokenRef = 'Success';

    if (serviceCategory === 'ELECTRICITY' && !isForeign) {
      dbPurchasedCode = payData.purchased_code || payData.token || payData.content?.transactions?.token || payData.content?.transactions?.purchased_code || null;
      if (!dbPurchasedCode) { const tokenMatch = JSON.stringify(payData).match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i); if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, ''); }
      alertTokenRef = dbPurchasedCode || 'Processing Token';
      vendedUnits = payData.units?.toString() || payData.content?.transactions?.units?.toString() || null;
    } else if (serviceCategory === 'EDUCATION') {
      dbPurchasedCode = payData.purchased_code || payData.Pin || null; alertTokenRef = dbPurchasedCode || 'Processing PIN';
    } else {
      alertTokenRef = payData.content?.transactions?.transactionId || payData.requestId || 'Success';
    }

    await supabase.from('transactions').update({ status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits }).eq('tx_hash', txHash);

    try {
      await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n📲 *Source:* ${channelBadge(source_channel)}\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Amount Paid:* ${displayAmount || `₦${vendAmount}`}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode}\n🧾 *Ref:* ${alertTokenRef}\n🔍 *Explorer:* ${explorerUrl}`);
    } catch (tgError) {
      console.error('Telegram Success Alert Error:', tgError);
    }

    if (serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION') {
      const typeLabel = serviceCategory === 'ELECTRICITY' ? 'Token' : 'PIN';
      sendAbaPaySms(phone || billersCode, `AbaPay: Your ${network || serviceCategory} ${typeLabel} is ${alertTokenRef}. Amount: N${vendAmount}. Thank you.`).catch(() => {});
    }

    if (email) {
      const premiumHtml = buildReceiptEmail({
        displayAmount: displayAmount || `₦${vendAmount.toLocaleString()}`,
        serviceLabel: `${network} ${serviceCategory}`,
        accountNumber: billersCode || phone || '',
        cryptoCharged: `${amount} ${tokenSymbol || 'USD₮'}`,
        txHash: txHash,
        purchasedCode: dbPurchasedCode,
        units: vendedUnits ? String(vendedUnits) : null,
        referenceId: vtRequestId,
        customerName: customer_name || null,
        customerAddress: customer_address || null,
      });

      try {
        await resend.emails.send({
          from: 'AbaPay Receipts <receipts@abapays.com>',
          to: email,
          replyTo: 'support@abapays.com',
          subject: `AbaPay Receipt - ${network} ${serviceCategory}`,
          html: premiumHtml,
        });
      } catch (emailError) {
        console.error('Resend API Error:', emailError);
      }
    }

    const points = Number((vendAmount / baseRate).toFixed(2));
    if (points > 0 && wallet_address) {
      supabase.rpc('award_transaction_points', { target_wallet: wallet_address.toLowerCase(), points_to_add: points }).then(({ error }) => {
        if (error) console.error('Points Error:', error.message);
      });
    }

    return { success: true, status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits, request_id: vtRequestId };
  } else {
    const friendlyMessage = error_messages[payData.code as string] || 'Service is temporarily undergoing maintenance.';
    await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: payData.code, api_response: payData.response_description }).eq('tx_hash', txHash);
    try {
      await sendTelegramAlert(`❌ *VENDING REJECTED*\n📲 *Source:* ${channelBadge(source_channel)}\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode}\n🚨 *Admin Error:* Code ${payData.code} - ${payData.response_description}\n🗣 *User Message:* ${friendlyMessage}\n🔍 *Explorer:* ${explorerUrl}`);
    } catch (tgError) {
      console.error('Telegram Failure Alert Error:', tgError);
    }

    // ⚡ AUTO-QUEUE THE REFUND — see src/lib/refunds.ts. We're only here because the
    // on-chain payment was already verified by the caller, so the user's crypto IS in
    // our vault and they received nothing.
    try {
      await enqueueRefund({
        txHash,
        walletAddress: wallet_address || '',
        tokenUsed: tokenSymbol || 'USD₮',
        amountCrypto: Number(amount),
        amountNaira: vendAmount,
        blockchain: blockchain || 'CELO',
        reason: 'VTpass vend rejected',
        vtpassError: `${payData.code}: ${payData.response_description}`,
        serviceCategory,
        sourceChannel: source_channel || 'WEB',
      });
    } catch (refundErr) {
      console.error('[Vend] Failed to queue refund:', refundErr);
    }

    return { success: false, status: 'FAILED_VENDING', message: `${friendlyMessage} Your funds are being refunded — you don't need to do anything.` };
  }
}
