import 'server-only';
import crypto from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass';
import { buildReceiptEmail } from '@/lib/receiptEmail';
import { enqueueRefund } from '@/lib/refunds';
import { initiateMonnifyBankTransfer } from '@/lib/monnifyVend';
import { checkProviderBalances } from '@/lib/balanceAlerts';
import { Resend } from 'resend';
import { normalizePurchasedCode, issuesTokenOrPin } from '@/lib/purchasedCode';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// 🔐 request_id generation now lives in ONE place — src/lib/requestId.ts. It used to be
// implemented here AND (identically) as generateRequestId() in src/lib/vtpass.js: two copies
// of a security-critical primitive, which is how one copy silently rots while the other is
// fixed. Re-exported so every existing `import { getStrictRequestId } from '@/lib/vend'`
// keeps working unchanged.
export { getStrictRequestId } from '@/lib/requestId';

// Human, reassuring phrasings — a failed vend already triggers an automatic refund, so the
// tone is "here's what happened, and you're covered," never a bare error code.
//
// 🔴 018 — THE MESSAGE THIS FIXES: 018 is VTpass's "LOW WALLET BALANCE", i.e. OUR merchant
// float is empty. It used to read "This service is briefly unavailable — please try again in
// a few minutes." Every word of that was wrong: it isn't brief, it isn't the service, and
// retrying CANNOT succeed until an operator tops the float up. In the 15 Jul - 12 Aug 2026
// incident that message invited users to re-pay on-chain over and over (87 attempts on one
// electricity provider alone), each retry costing them gas and another refund cycle. Never
// invite a retry for a condition the user cannot possibly clear.
const error_messages: Record<string, string> = {
  '011': "That didn't go through — please double-check the phone or meter number.",
  '014': "You've hit the provider's daily limit for this service. Try again tomorrow.",
  '016': "The provider's network is a bit shaky right now — worth trying again shortly.",
  '018': "We couldn't complete this one on our side. Your payment is being refunded in full — please don't retry, we're on it.",
  '030': "The provider's network is down at the moment. Please try again soon.",
  '400': 'Something went wrong on the provider side while processing this.',
};

// VTpass codes that mean OUR float is the problem, not the user and not the provider's
// network. These are the ones that will keep failing, identically, for every single customer
// until an operator acts — so they must escalate immediately rather than blend into the
// per-transaction failure stream.
const FLOAT_EXHAUSTED_CODES = new Set(['018']);

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
    serviceCategory,
  } = input;

  // ⚡ Bank transfers don't go to VTpass at all — they're real NUBAN payouts through Monnify
  // (Moniepoint Inc.'s API), debiting the operator's Moniepoint business account. See
  // src/lib/monnifyVend.ts for why this rail is inherently async (submit now, confirm via
  // webhook/reconcile later) unlike VTpass's mostly-synchronous /pay.
  if (serviceCategory === 'BANK') {
    return initiateMonnifyBankTransfer(input);
  }

  const {
    vtRequestId, txHash, serviceID, network, billersCode, phone,
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
      // normalizePurchasedCode: VTpass returns the placeholder "Token : N/A" rather than
      // omitting the field. Storing it verbatim is what produced "Token : Token : N/A" on the
      // receipt; nulling it also lets the regex scan below still look for a real token.
      dbPurchasedCode = normalizePurchasedCode(payData.purchased_code || payData.token || payData.content?.transactions?.token || payData.content?.transactions?.purchased_code);
      if (!dbPurchasedCode) { const tokenMatch = JSON.stringify(payData).match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i); if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, ''); }
      alertTokenRef = dbPurchasedCode || 'Processing Token';
      vendedUnits = payData.units?.toString() || payData.content?.transactions?.units?.toString() || null;
    } else if (serviceCategory === 'EDUCATION') {
      dbPurchasedCode = normalizePurchasedCode(payData.purchased_code || payData.Pin); alertTokenRef = dbPurchasedCode || 'Processing PIN';
    } else {
      alertTokenRef = payData.content?.transactions?.transactionId || payData.requestId || 'Success';
    }

    await supabase.from('transactions').update({ status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits }).eq('tx_hash', txHash);

    try {
      await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n📲 *Source:* ${channelBadge(source_channel)}\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Amount Paid:* ${displayAmount || `₦${vendAmount}`}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode}\n🧾 *Ref:* ${alertTokenRef}\n🔍 *Explorer:* ${explorerUrl}`);
    } catch (tgError) {
      console.error('Telegram Success Alert Error:', tgError);
    }

    // 🔴 POSTPAID GETS NO SMS. The guard was `category === ELECTRICITY || EDUCATION`, which
    // texted postpaid customers "Your IBADAN-ELECTRIC Token is Token : N/A" — a token that does
    // not exist and never will, because postpaid meters are billed accounts. issuesTokenOrPin
    // keeps the original cost rationale (only text when there is a code worth delivering)
    // while telling the truth about which purchases actually produce one.
    if (issuesTokenOrPin(serviceCategory, variation_code)) {
      const typeLabel = serviceCategory === 'ELECTRICITY' ? 'Token' : 'PIN';
      sendAbaPaySms(phone || billersCode, `AbaPay: Your ${network || serviceCategory} ${typeLabel} is ${alertTokenRef}. Amount: N${vendAmount}. Thank you.`).catch(() => {});
    }

    if (email) {
      const premiumHtml = buildReceiptEmail({
        displayAmount: displayAmount || `₦${vendAmount.toLocaleString()}`,
        serviceLabel: `${network} ${serviceCategory}`,
        serviceId: serviceID,
        serviceCategory,
        variationCode: variation_code,
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
    const friendlyMessage = error_messages[payData.code as string] || "The provider couldn't complete this one right now.";
    await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: payData.code, api_response: payData.response_description }).eq('tx_hash', txHash);

    // 🔴 THE MONITORING GAP THIS FIXES: when the VTpass float ran dry on 15 Jul 2026, this
    // branch fired 226 times over four weeks and nobody noticed — because each occurrence
    // looked like an ordinary per-transaction "VENDING REJECTED" alert among many, and the one
    // function that would have said "YOUR FLOAT IS EMPTY, TOP IT UP" (checkProviderBalances)
    // only ran if an external cron happened to hit /api/cleanup. The Monnify rail already got
    // this right — src/lib/monnifyVend.ts force-triggers the balance check the moment it sees
    // an insufficient-balance error, bypassing the 6h cooldown. The VTpass rail, which handles
    // every airtime/data/electricity/cable/education payment, did not. Now it does.
    //
    // Fire-and-forget: a monitoring call must never delay or break the refund below.
    if (FLOAT_EXHAUSTED_CODES.has(String(payData.code))) {
      checkProviderBalances({ force: true }).catch(() => {});
    }

    try {
      // Float exhaustion is an OPERATOR emergency, not a customer support ticket — label it as
      // such so it can't be skimmed past as one more routine rejection.
      const isFloatIssue = FLOAT_EXHAUSTED_CODES.has(String(payData.code));
      const header = isFloatIssue
        ? `🔴 *FLOAT EXHAUSTED — VENDING HALTED*\n\n_Every ${serviceCategory} payment will keep failing and auto-refunding until the VTpass wallet is topped up._\n`
        : `❌ *VENDING REJECTED*`;
      await sendTelegramAlert(`${header}\n📲 *Source:* ${channelBadge(source_channel)}\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode}\n🚨 *Admin Error:* Code ${payData.code} - ${payData.response_description}\n🗣 *User Message:* ${friendlyMessage}\n🔍 *Explorer:* ${explorerUrl}`);
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
        userMessage: friendlyMessage,
        serviceCategory,
        sourceChannel: source_channel || 'WEB',
      });
    } catch (refundErr) {
      console.error('[Vend] Failed to queue refund:', refundErr);
    }

    return { success: false, status: 'FAILED_VENDING', message: `${friendlyMessage} Your funds are being refunded — you don't need to do anything.` };
  }
}
