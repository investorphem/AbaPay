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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      serviceID, serviceCategory, network, billersCode, phone,
      token: tokenSymbol, variation_code, subscription_type,
      nairaAmount, foreignAmount, displayAmount, wallet_address,
      operator_id, country_code, product_type_id, email,
      meter_account_type, blockchain,
      customer_name, customer_address, source_channel,
    } = body;

    // Scope: Celo + USDC only at launch (see README — EIP-3009 support confirmed for
    // Celo-native USDC; cUSD/USDT support on the facilitator is not independently confirmed).
    if ((blockchain || '').toUpperCase() !== 'CELO' || tokenSymbol !== 'USDC') {
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'x402 settlement is only available for USDC on Celo.' }, { status: 400 });
    }

    const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_NETWORK === 'celo' || process.env.NEXT_PUBLIC_NETWORK === 'base';
    const isForeign = serviceID === 'foreign-airtime';
    const requestedNaira = parseFloat(nairaAmount);
    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira;
    const vtRequestId = getStrictRequestId();

    const explorerBase = isMainnet ? 'https://celoscan.io' : 'https://sepolia.celoscan.io';

    // 1. RATE — the same server-side source of truth /api/pay uses. Unlike the contract
    // path, we don't need to verify a client-claimed amount against calldata: WE set the
    // price passed to the facilitator below, so the payer can only pay exactly what we ask.
    const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
    const baseRate = parseFloat(settingsData?.exchange_rate || '1500');
    const requiredCrypto = (vendAmount + serviceFee) / baseRate;

    const usdc = resolveTokenOnChain('USDC', 'CELO', isMainnet);
    if (!usdc) {
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'USDC is not configured for this network.' }, { status: 500 });
    }
    const requiredWei = BigInt(Math.round(requiredCrypto * 10 ** usdc.decimals));

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
      method: 'POST',
      paymentData: req.headers.get('x-payment') || req.headers.get('payment-signature'),
      payTo,
      network: isMainnet ? celo : celoSepoliaTestnet,
      price: { amount: requiredWei.toString(), asset: { address: usdc.address as `0x${string}`, decimals: usdc.decimals } },
      facilitator: thirdwebFacilitator,
      routeConfig: {
        description: `AbaPay ${network || serviceCategory} bill payment`,
      },
    });

    if (result.status !== 200) {
      // Payment required (or invalid) — hand thirdweb's 402 straight back so the client's
      // fetchWithPayment can sign and retry.
      return NextResponse.json(result.responseBody, { status: result.status, headers: result.responseHeaders });
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
      baseRate, explorerUrl,
    });

    // The client never sees this transaction directly (the facilitator submits it, not the
    // browser's wallet) — unlike the contract-call path, so it has to come back explicitly.
    return NextResponse.json({ ...vendResult, tx_hash: txHash });
  } catch (error: any) {
    console.error('[Pay/x402] error:', error);
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling x402 payment.' }, { status: 500 });
  }
}
