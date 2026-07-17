import { NextResponse } from 'next/server';
import { createThirdwebClient } from 'thirdweb';
import { celo, celoSepoliaTestnet } from 'thirdweb/chains';
import { facilitator, settlePayment } from 'thirdweb/x402';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { resolveTokenOnChain } from '@/constants';

// ⚡ x402 SETTLEMENT — MAIN APP ONLY, CELO + USDC ONLY
//
// This is a SEPARATE settlement rail from the contract-call flow in /api/pay. It exists so
// payments made here are genuinely visible on x402scan (real facilitator settlement, real
// EIP-3009 signature from the payer) rather than a relabeled contract call.
//
// It is deliberately scoped to the main app: x402 requires a fresh signature from the payer
// for every payment, which is incompatible with the signature-free agent-initiated flow
// (AbaPayV3.payBillFor via src/lib/deai/relayer.ts) — that flow is completely untouched.
//
// payTo is the SAME AbaPayV3 vault the contract-call flow pays into, so the existing
// admin balance/refund/withdrawal tooling needs zero changes — it just reads balanceOf,
// which doesn't care how the tokens arrived. See README.md "x402 settlement" section.
//
// 🔴 REQUEST VALIDATION MUST NEVER RUN BEFORE THE PAYMENT CHALLENGE. x402 discovery
// crawlers (x402scan et al.) probe this URL with arbitrary/empty/GET requests to confirm
// it's a real x402 resource — they expect a 402 challenge back, not a 400 from our own
// field validation or a 405 from a missing method handler. Fallback to the published
// minimum price (public/openapi.json's x-payment-info.min) when the real bill amount
// isn't present, so ANY request gets a valid challenge; only actually vend a bill once a
// real payment settles AND we have real bill details.

const FALLBACK_MIN_USDC = '0.05'; // matches public/openapi.json's x-payment-info.price.min

async function handleX402Request(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // No/invalid JSON body (a bare probe, or a GET request) — fall through with an empty
    // body; the price fallback below still produces a valid 402 challenge.
  }

  const {
    serviceID, serviceCategory, network, billersCode, phone,
    token: tokenSymbol, variation_code, subscription_type,
    nairaAmount, foreignAmount, displayAmount, wallet_address,
    operator_id, country_code, product_type_id, email,
    meter_account_type, blockchain,
    customer_name, customer_address, source_channel,
  } = body;

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_NETWORK === 'celo' || process.env.NEXT_PUBLIC_NETWORK === 'base';
  const isForeign = serviceID === 'foreign-airtime';
  const requestedNaira = parseFloat(nairaAmount);
  const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
  const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
  const vendAmount = Number.isFinite(requestedNaira) && requestedNaira > 0 ? requestedNaira : null;
  const vtRequestId = getStrictRequestId();

  const explorerBase = isMainnet ? 'https://celoscan.io' : 'https://sepolia.celoscan.io';

  const usdc = resolveTokenOnChain('USDC', 'CELO', isMainnet);
  if (!usdc) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'USDC is not configured for this network.' }, { status: 500 });
  }

  // 1. RATE — the same server-side source of truth /api/pay uses. Unlike the contract
  // path, we don't need to verify a client-claimed amount against calldata: WE set the
  // price passed to the facilitator below, so the payer can only pay exactly what we ask.
  // Falls back to a nominal minimum when there's no real bill amount to price (a probe,
  // or a malformed request) — that request just never has enough detail to vend anything.
  let requiredWei: bigint;
  let requiredCrypto: number;
  let baseRate = 1500; // fallback only ever used when vendAmount is null (no real bill to price)
  if (vendAmount !== null) {
    const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
    baseRate = parseFloat(settingsData?.exchange_rate || '1500');
    requiredCrypto = (vendAmount + serviceFee) / baseRate;
    requiredWei = BigInt(Math.round(requiredCrypto * 10 ** usdc.decimals));
  } else {
    requiredCrypto = Number(FALLBACK_MIN_USDC);
    requiredWei = BigInt(Math.round(requiredCrypto * 10 ** usdc.decimals));
  }

  const client = createThirdwebClient({ secretKey: process.env.THIRDWEB_SECRET_KEY! });
  const thirdwebFacilitator = facilitator({
    client,
    serverWalletAddress: process.env.THIRDWEB_SERVER_WALLET_ADDRESS!,
  });

  const payTo = process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS;
  if (!payTo) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Vault address not configured.' }, { status: 500 });
  }

  const result = await settlePayment({
    resourceUrl: req.url,
    method: req.method,
    paymentData: req.headers.get('x-payment') || req.headers.get('payment-signature'),
    payTo,
    network: isMainnet ? celo : celoSepoliaTestnet,
    price: { amount: requiredWei.toString(), asset: { address: usdc.address as `0x${string}`, decimals: usdc.decimals } },
    facilitator: thirdwebFacilitator,
    routeConfig: {
      description: `AbaPay ${network || serviceCategory || 'bill'} payment`,
    },
  });

  if (result.status !== 200) {
    // thirdweb's SDK always uses x402 protocol v2 for a fresh, unauthenticated challenge
    // (no client payment header yet) — v2 delivers the challenge via a base64 PAYMENT-REQUIRED
    // header and deliberately leaves responseBody empty ({}). thirdweb's own fetchWithPayment
    // client reads that header correctly, but generic x402 scanners/crawlers (x402scan's
    // discovery probe, most third-party clients) expect the challenge in the response BODY —
    // that mismatch is exactly why registration failed with "No valid x402 response found"
    // despite the status code being a correct 402. Decode the header back into JSON and put
    // it in the body too, so both conventions are satisfied from the same response.
    let responseBody: unknown = result.responseBody;
    const isEmptyBody = responseBody && typeof responseBody === 'object' && Object.keys(responseBody).length === 0;
    if (isEmptyBody) {
      const challengeHeader = result.responseHeaders?.['PAYMENT-REQUIRED'] || result.responseHeaders?.['payment-required'];
      if (challengeHeader) {
        try {
          responseBody = JSON.parse(Buffer.from(challengeHeader, 'base64').toString('utf-8'));
        } catch {
          // Fall through with the original (empty) body if decoding fails for any reason.
        }
      }
    }
    return NextResponse.json(responseBody, { status: result.status, headers: result.responseHeaders });
  }

  // ⚡ Payment is now CONFIRMED and irreversibly settled. Everything past this point is
  // "do we have enough to actually vend a bill" — scope/field checks live here, not before
  // the payment gate, so they never interfere with discovery probing.
  if ((blockchain || '').toUpperCase() !== 'CELO' || tokenSymbol !== 'USDC' || vendAmount === null || !serviceID || !billersCode) {
    console.error('[Pay/x402] Payment settled but request lacked real bill details:', { blockchain, tokenSymbol, vendAmount, serviceID, billersCode });
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Payment settled, but the request was missing bill details — contact support with your transaction hash.' }, { status: 400 });
  }

  const txHash = result.paymentReceipt.transaction;
  const payer = result.paymentReceipt.payer;

  // Cross-check the payer matches who the frontend claims is paying — mirrors the
  // SENDER_MISMATCH check in /api/webhook for the contract-call path.
  if (payer && wallet_address && payer.toLowerCase() !== String(wallet_address).toLowerCase()) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Payer address mismatch.' }, { status: 400 });
  }

  const explorerUrl = `${explorerBase}/tx/${txHash}`;

  // Record the transaction, then atomically lock it before vending — same pattern as
  // /api/pay, so a retried request with the same settlement tx can't double-vend.
  const dbPayload = {
    tx_hash: txHash, request_id: vtRequestId, service_category: serviceCategory, service_id: serviceID,
    variation_code: variation_code, network: network, blockchain: 'CELO',
    account_number: billersCode || phone || 'N/A', phone: phone || null,
    amount_usdt: requiredCrypto, amount_naira: vendAmount, fee_naira: serviceFee, status: 'PENDING',
    wallet_address: (payer || wallet_address || 'UNKNOWN').toLowerCase(),
    customer_name: customer_name || null, customer_address: customer_address || null,
    source_channel: source_channel || 'WEB', token_used: tokenSymbol,
    meter_account_type: meter_account_type || null, customer_email: email || null,
    operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null,
    subscription_type: subscription_type || null,
    foreign_amount: foreignAmount || null, display_amount: displayAmount || null,
    payment_method: 'X402',
  };

  await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });

  const { data: lockedRecord, error: lockError } = await supabase
    .from('transactions')
    .update({ status: 'PROCESSING', request_id: vtRequestId })
    .eq('tx_hash', txHash)
    .eq('status', 'PENDING')
    .select()
    .single();

  if (!lockedRecord || lockError) {
    return NextResponse.json({ success: true, status: 'TIMEOUT', message: 'This payment is already being processed.' });
  }

  const vendResult = await executeVend({
    vtRequestId, txHash, serviceID, serviceCategory, network, billersCode, phone,
    variation_code, subscription_type, amount: requiredCrypto, tokenSymbol, vendAmount, displayAmount,
    foreignAmount, isForeign, operator_id, country_code, product_type_id, email,
    wallet_address: payer || wallet_address, blockchain: 'CELO', source_channel, customer_name, customer_address,
    baseRate,
    explorerUrl,
  });

  // The client never sees this transaction directly (the facilitator submits it, not the
  // browser's wallet) — unlike the contract-call path, so it has to come back explicitly.
  return NextResponse.json({ ...vendResult, tx_hash: txHash });
}

export async function POST(req: Request) {
  try {
    return await handleX402Request(req);
  } catch (error: any) {
    console.error('[Pay/x402] error:', error);
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling x402 payment.' }, { status: 500 });
  }
}

// x402 discovery crawlers (and some clients) probe with GET to confirm a resource is a
// real, valid x402 endpoint before ever attempting a real payment — without this, they see
// a 405 (no handler for GET) instead of the 402 challenge they're looking for. AbaPay's own
// app never uses this path (it always POSTs full bill details), so a GET here always falls
// back to the nominal minimum price and can never actually vend anything.
export async function GET(req: Request) {
  try {
    return await handleX402Request(req);
  } catch (error: any) {
    console.error('[Pay/x402] error:', error);
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling x402 payment.' }, { status: 500 });
  }
}
