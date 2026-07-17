import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { resolveTokenOnChain } from '@/constants';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ x402 SETTLEMENT — MAIN APP ONLY, CELO + USDC ONLY, via Celo's own x402 facilitator
// (api.x402.celo.org / api.x402.sepolia.celo.org — "Built by Celo Core Co.") — NOT thirdweb.
//
// Switched off thirdweb for this route because:
//   1. thirdweb requires a paid billing plan to settle on mainnet at all (DELEGATION_CHECK_FAILED
//      otherwise) and takes ~0.3% per settlement. Celo's facilitator is flat $0.001/settlement,
//      prepaid via credits, no billing plan required.
//   2. thirdweb's SDK routes payment through ITS OWN server wallet first, then forwards to the
//      real recipient in a separate step (visible as a 3-call batch on-chain). Celo's facilitator
//      is genuinely non-custodial — the signed EIP-3009 authorization pays `payTo` (our vault)
//      DIRECTLY; the facilitator only ever submits the pre-signed transaction, never holds funds.
//   3. thirdweb's SDK always uses x402 protocol v2 for a fresh challenge, delivering it via a
//      base64 header with an EMPTY response body — incompatible with generic x402 scanners
//      (x402scan's crawler included) that expect the challenge in the body. Building the 402
//      response ourselves (as v1, body-based) sidesteps that entirely.
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
const CELO_FACILITATOR_MAINNET = 'https://api.x402.celo.org';
const CELO_FACILITATOR_TESTNET = 'https://api.x402.sepolia.celo.org';

interface CeloSettleResponse {
  success: boolean;
  network: string;
  transaction: string;
  payer: string;
  errorReason?: string;
  errorMessage?: string;
}

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

  const payTo = process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS;
  if (!payTo) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Vault address not configured.' }, { status: 500 });
  }

  const apiKey = process.env.CELO_X402_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'x402 is not configured.' }, { status: 500 });
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

  // The x402 payment header the client signs and retries with. thirdweb's client-side
  // useFetchWithPayment (already wired in the main app) reads the challenge from the
  // response BODY when there's no PAYMENT-REQUIRED header — see fetchWithPayment.js — so
  // building a plain v1-style body here works for both our own app AND generic scanners.
  const paymentHeader = req.headers.get('x-payment') || req.headers.get('payment-signature');

  const resourceUrl = req.url;
  const caip2Network = isMainnet ? 'eip155:42220' : 'eip155:11142220';
  const celoNetworkName = isMainnet ? 'celo' : 'celo-sepolia';
  const facilitatorBaseUrl = isMainnet ? CELO_FACILITATOR_MAINNET : CELO_FACILITATOR_TESTNET;

  const acceptEntry = {
    scheme: 'exact',
    network: caip2Network,
    maxAmountRequired: requiredWei.toString(),
    resource: resourceUrl,
    description: `AbaPay ${network || serviceCategory || 'bill'} payment`,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 86400,
    asset: usdc.address,
    extra: { name: 'USDC', version: '2', primaryType: 'TransferWithAuthorization' },
  };

  if (!paymentHeader) {
    // No payment attempted yet — issue the challenge. v1, body-based: works for both
    // thirdweb's client (body fallback) and generic x402 scanners (body is all they read).
    return NextResponse.json(
      { x402Version: 1, error: 'Payment required', accepts: [acceptEntry] },
      { status: 402 }
    );
  }

  // A payment header is present — decode it and forward it to Celo's facilitator to settle.
  // Their /settle endpoint does verify + settle in one call, and per their own docs only
  // successful settlements consume a credit, so there's no need for a separate /verify
  // pre-check here.
  //
  // The header is base64 JSON produced by thirdweb's client (see node_modules/thirdweb/src/x402/encode.ts
  // encodePayment / sign.ts preparePaymentHeader) in the FLAT x402 v1 shape:
  //   { x402Version, scheme, network, payload: { signature, authorization } }
  // thirdweb can only resolve a chain ID for signing from a CAIP-2 network string (e.g.
  // "eip155:42220") — it has no idea what "celo" means — so `acceptEntry.network` above must
  // stay CAIP-2 for the client to sign successfully. But Celo's facilitator's /supported
  // endpoint (verified live via curl) only lists these two exact (x402Version, scheme, network)
  // combos: {2, exact, eip155:42220} and {1, exact, celo}. Since thirdweb always tags whatever
  // x402Version we told it (1 here) onto the flat payload, our actual signed payload is
  // {1, exact, eip155:42220} — which matches NEITHER kind — hence "unsupported_scheme".
  // Fix: relabel `network` from CAIP-2 to the plain name (celoNetworkName) only in the copy we
  // send to the facilitator. This is safe — the EIP-712 signature was already made over
  // domain.chainId 42220 (derived from the CAIP-2 string at signing time), so this network
  // label is pure metadata and doesn't affect signature validity.
  let settleResult: CeloSettleResponse;
  try {
    let decodedPayload: any;
    try {
      decodedPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } catch {
      return NextResponse.json({ x402Version: 1, error: 'Malformed X-PAYMENT header', accepts: [acceptEntry] }, { status: 402 });
    }

    const facilitatorPaymentPayload = { ...decodedPayload, network: celoNetworkName };
    const facilitatorPaymentRequirements = { ...acceptEntry, network: celoNetworkName };

    const settleRes = await fetch(`${facilitatorBaseUrl}/settle`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: decodedPayload.x402Version || 1,
        paymentPayload: facilitatorPaymentPayload,
        paymentRequirements: facilitatorPaymentRequirements,
      }),
    });
    settleResult = await settleRes.json();
  } catch (err: any) {
    console.error('[Pay/x402] Celo facilitator unreachable:', err?.message);
    return NextResponse.json({ x402Version: 1, error: 'Facilitator temporarily unavailable', accepts: [acceptEntry] }, { status: 402 });
  }

  if (!settleResult.success) {
    // "0 credits" also comes back as a settle failure per Celo's own docs ("the facilitator
    // returns 402 Payment Required until you top up") — that's an operator problem, not a
    // payer one, so alert rather than silently telling the payer to just retry.
    const looksLikeCreditExhaustion = /credit/i.test(settleResult.errorReason || '') || /credit/i.test(settleResult.errorMessage || '');
    if (looksLikeCreditExhaustion) {
      sendTelegramAlert(`🚨 *x402 FACILITATOR OUT OF CREDITS*\n\nCelo x402 settlement is failing — top up USDC credits at x402.celo.org.\n\nReason: ${settleResult.errorMessage || settleResult.errorReason}`).catch(() => {});
    } else {
      console.error('[Pay/x402] Settle failed:', settleResult.errorReason, settleResult.errorMessage);
    }
    return NextResponse.json(
      { x402Version: 1, error: settleResult.errorMessage || settleResult.errorReason || 'Payment required', accepts: [acceptEntry] },
      { status: 402 }
    );
  }

  // ⚡ Payment is now CONFIRMED and irreversibly settled. Everything past this point is
  // "do we have enough to actually vend a bill" — scope/field checks live here, not before
  // the payment gate, so they never interfere with discovery probing.
  if ((blockchain || '').toUpperCase() !== 'CELO' || tokenSymbol !== 'USDC' || vendAmount === null || !serviceID || !billersCode) {
    console.error('[Pay/x402] Payment settled but request lacked real bill details:', { blockchain, tokenSymbol, vendAmount, serviceID, billersCode, tx: settleResult.transaction });
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Payment settled, but the request was missing bill details — contact support with your transaction hash.' }, { status: 400 });
  }

  const txHash = settleResult.transaction;
  const payer = settleResult.payer;

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
