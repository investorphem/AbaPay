import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { getStrictRequestId } from '@/lib/vend';
import { getActiveDiscountForService, computeDiscountNgn } from '@/lib/discounts';
import { isDuplicateElectricity } from '@/lib/parity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { checkWebPayment } from '@/lib/serviceRules';
import { billCharges } from '@/lib/billCharges';
import { metric } from '@/lib/log';
import { LUNA_PER_NIM, NIM_TX_HASH_RE, PRICE_BUFFER, canonicalNimAddress, formatNimAddress, isNimAddress, lunaForUsd, nimUsdPrice, paymentReference, recentTreasuryPayments, treasuryAddress } from '@/lib/nimiq';
import { NIM_INTENT_PREFIX, settleNimIntent } from '@/lib/nimSettle';

// ⚡ /api/pay/nim — THE NIM RAIL, used by the Nimiq Pay mini app on nim.abapays.com.
//
//   1. INTENT  ({ intent: true, ...bill, payer }) — the server prices the bill in NIM, runs the
//      same pre-payment guards as /api/pay, and records a PENDING row under an id it chose
//      (preflight_nim_<uuid>). It answers with the treasury address, the luna owed and the
//      reference the payment must carry.
//   2. SETTLE  ({ intent_id, tx_hash }) — after Nimiq Pay sent the NIM, the server reads the
//      transaction from the Nimiq chain and checks it against the row (src/lib/nimSettle.ts),
//      then vends from the row.
//
// The price is fixed at intent time: the row's amount is what settlement requires. NIM is priced
// from its live US-dollar price plus a small buffer (src/lib/nimiq.ts lunaForUsd), and naira
// from the platform rate, exactly as the stablecoin rails price it.
//
// Refunds for a failed vend are queued as usual (blockchain 'NIMIQ', token 'NIM'), and sent by
// the operator from the treasury wallet: the server holds no Nimiq key.

export const maxDuration = 120;

interface NimPayRequest {
  intent?: boolean;
  intent_id?: string; tx_hash?: string;
  payer?: string;
  serviceID?: string; serviceCategory?: string; network?: string; billersCode?: string;
  nairaAmount?: string | number; variation_code?: string; phone?: string; email?: string;
  subscription_type?: string; meter_account_type?: string; customer_name?: string; customer_address?: string;
  foreignAmount?: string | number; displayAmount?: string;
  operator_id?: string | number; country_code?: string; product_type_id?: string | number;
}

const alert = (text: string) => sendTelegramAlert(text).catch(() => {});
const fail = (status: number, message: string, code?: string) =>
  NextResponse.json({ success: false, status: 'FAILED_VENDING', code, message }, { status });

/**
 * What the mini app needs to show a live NIM estimate before an order exists: the NIM price, the
 * naira rate and the buffer. The intent's own quote is the binding one.
 */
export async function GET() {
  const [nimUsd, { data: settings }] = await Promise.all([
    nimUsdPrice(),
    supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single(),
  ]);
  return NextResponse.json({
    available: !!treasuryAddress() && !!nimUsd,
    nim_usd: nimUsd,
    ngn_per_usd: parseFloat(settings?.exchange_rate || '1500'),
    buffer: PRICE_BUFFER,
  }, { headers: { 'Cache-Control': 'public, max-age=30' } });
}

export async function POST(req: Request) {
  // 60/min per client: the mini app polls settle every few seconds while confirmations arrive.
  const limited = await enforceRateLimit(req, 'pay_nim', 60, 60);
  if (limited) return limited;

  let body: NimPayRequest;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid request.');
  }
  return body.intent ? createIntent(req, body) : settle(body);
}

async function createIntent(req: Request, body: NimPayRequest) {
  const treasury = treasuryAddress();
  if (!treasury) return fail(503, 'NIM payments are temporarily unavailable.', 'TREASURY_NOT_CONFIGURED');

  const payer = String(body.payer || '');
  if (!isNimAddress(payer)) return fail(400, 'Open this app inside Nimiq Pay to pay with NIM.', 'PAYER_REQUIRED');

  const {
    serviceID, serviceCategory, network, billersCode, variation_code, phone, email,
    nairaAmount, foreignAmount, displayAmount, subscription_type, meter_account_type,
    customer_name, customer_address, operator_id, country_code, product_type_id,
  } = body;

  const vendAmount = Number(nairaAmount);
  if (!Number.isFinite(vendAmount) || vendAmount <= 0) return fail(400, 'Invalid bill amount.');

  // Same server-side service gate as /api/pay: kill switches and live provider limits.
  const cat = String(serviceCategory || '').toUpperCase();
  const gate = await checkWebPayment({
    serviceCategory, serviceID, amountNgn: vendAmount,
    isFixedPlan: ['INTERNET', 'DATA', 'CABLE', 'EDUCATION'].includes(cat) && !!variation_code && variation_code !== 'none',
  });
  if (!gate.allowed) return fail(gate.code === 'AMOUNT_OUT_OF_RANGE' ? 400 : 409, gate.reason || 'This service is unavailable right now.', gate.code);

  const { serviceFee, stampDutyNgn } = billCharges({ serviceCategory, serviceID, network, amountNgn: vendAmount });

  const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
  const baseRate = parseFloat(settingsData?.exchange_rate || '1500');

  const discountServiceKey = cat.startsWith('INTL') ? 'INTERNATIONAL' : serviceCategory;
  const destinationAccount = billersCode || phone || 'N/A';
  const payerCanonical = canonicalNimAddress(payer);
  const activeDiscount = await getActiveDiscountForService(discountServiceKey || null);
  const { discountNgn, discountPhone } = await computeDiscountNgn(vendAmount, activeDiscount, payerCanonical, destinationAccount);

  const usd = (vendAmount + serviceFee + stampDutyNgn - discountNgn) / baseRate;
  const nimUsd = await nimUsdPrice();
  if (!nimUsd) return fail(503, 'Couldn’t read the NIM price right now. Please try again in a minute.', 'PRICE_UNAVAILABLE');
  const luna = lunaForUsd(usd, nimUsd);

  if (serviceCategory === 'ELECTRICITY' && await isDuplicateElectricity(supabase, payerCanonical, destinationAccount, vendAmount)) {
    return NextResponse.json({
      success: false, status: 'DUPLICATE',
      message: `You already paid ₦${vendAmount.toLocaleString()} to meter ${destinationAccount} today. If you really meant to pay again, wait a moment and try again, or contact support.`,
    }, { status: 409 });
  }

  const clientIp = discountNgn > 0 ? (req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null) : null;
  const intentId = `${NIM_INTENT_PREFIX}${randomUUID()}`;

  const { error } = await supabase.from('transactions').insert({
    tx_hash: intentId, request_id: getStrictRequestId(), service_category: serviceCategory, service_id: serviceID,
    variation_code, network, blockchain: 'NIMIQ', account_number: destinationAccount, phone: phone || null,
    // On NIM rows amount_usdt is the NIM charged, the same "crypto charged, in token_used" every
    // receipt and refund path reads. nim_usd_price keeps the quote so totals can be shown in USD.
    amount_usdt: luna / LUNA_PER_NIM, nim_usd_price: nimUsd, token_used: 'NIM',
    amount_naira: vendAmount, fee_naira: serviceFee, stamp_duty_ngn: stampDutyNgn, discount_ngn: discountNgn,
    discount_campaign_id: activeDiscount?.id || null, discount_phone: discountPhone, client_ip: clientIp,
    status: 'PENDING', wallet_address: payerCanonical, source_channel: 'NIMIQ',
    customer_name: customer_name || null, customer_address: customer_address || null,
    meter_account_type: meter_account_type || null, customer_email: email || null,
    operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null,
    subscription_type: subscription_type || null, foreign_amount: foreignAmount || null, display_amount: displayAmount || null,
  });
  if (error) {
    console.error('[Pay/NIM] intent insert failed:', error.message);
    await alert(`🚨 *NIM INTENT WRITE FAILED*\nCouldn't record a ${serviceCategory} order — refused before payment.\n👤 Payer: \`${payerCanonical}\`\n🛑 ${error.message}`);
    return fail(500, 'Couldn’t start this payment. Please try again or contact support.');
  }

  metric('payment_intents_total', 1, { rail: 'nim', service: cat });
  return NextResponse.json({
    success: true,
    status: 'PENDING',
    intent_id: intentId,
    recipient: formatNimAddress(treasury),
    luna,
    nim: luna / LUNA_PER_NIM,
    reference: paymentReference(intentId),
    nim_usd: nimUsd,
    charges: { serviceFee, stampDutyNgn, discountNgn },
  });
}

async function settle(body: NimPayRequest) {
  const intentId = String(body.intent_id || '');
  if (!intentId.startsWith(NIM_INTENT_PREFIX) || intentId.length > 100) return fail(400, 'Invalid order.');

  // Nimiq Pay doesn't always hand the app a usable hash. Without one, find the payment on chain
  // by the reference it carries: the intent id is the reference, so this is still exact.
  let txHash = String(body.tx_hash || '').toLowerCase();
  if (!NIM_TX_HASH_RE.test(txHash)) {
    const found = (await recentTreasuryPayments(200))?.get(paymentReference(intentId));
    if (!found) return NextResponse.json({ success: false, status: 'TIMEOUT', verifying: true, message: 'Waiting for your NIM payment to reach the network.' });
    txHash = found.hash.toLowerCase();
  }

  const { data: row } = await supabase.from('transactions').select('*').eq('tx_hash', intentId).maybeSingle();
  // The row is renamed to the real hash once settled; a retried settle finds it by that hash.
  const byHash = row ? null : (await supabase.from('transactions').select('*').eq('tx_hash', txHash).maybeSingle()).data;
  const target = row || byHash;
  if (!target) return fail(404, 'Order not found.', 'INTENT_NOT_FOUND');

  const out = await settleNimIntent(target, txHash);
  const httpStatus = out.success || out.status === 'TIMEOUT' ? 200 : out.code === 'PAYMENT_ALREADY_USED' ? 409 : 400;
  return NextResponse.json(out, { status: httpStatus });
}
