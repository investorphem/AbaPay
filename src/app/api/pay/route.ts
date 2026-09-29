import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { vendInputFromRow } from '@/lib/vendInput';
import { getActiveDiscountForService, computeDiscountNgn } from '@/lib/discounts';
import { isDuplicateElectricity } from '@/lib/parity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { explorerBaseFor } from '@/lib/chain';
import { verifyVaultPayment, UNDECIDED_PROOF_FAILURES } from '@/lib/paymentProof';
import { normalizeChainName, LEGACY_RECORD_CHAIN } from '@/constants';

// ⚡ /api/pay — THE WEB APP'S CONTRACT-CALL RAIL. Two calls per payment:
//
//   1. INTENT  (`intent_only: true`, before the wallet is asked to sign). The server prices the
//      bill, runs the pre-signature guards and records a PENDING row under an intent id THE
//      SERVER CHOSE. Everything the vend will later use is fixed here.
//   2. SETTLE  (`intent_only: false`, `intent_id` + the real `txHash`, after the payBill
//      transaction confirms). The server proves on-chain that the vault received exactly what the
//      INTENT ROW says (src/lib/paymentProof.ts), attaches the hash to the row and takes the vend
//      lock in one conditional write, then vends FROM THE ROW.
//
// 🔴 WHAT THIS REPLACED (ABAPAY_FULL_AUDIT.md P-1 / P-2):
//   • The intent write was `upsert(..., { onConflict: 'tx_hash' })` on a tx_hash the caller
//     supplied. Pointing it at an existing row reset that row to PENDING with a fresh request_id,
//     and re-submitting the same (still valid) on-chain hash vended it again — including rows
//     that had already been REFUNDED. The intent is now an INSERT under a server-generated id; a
//     real 0x hash is never accepted there. (DB-level backstop: migration 026's state guard.)
//   • Settlement decoded the payBill CALLDATA, never checked its token argument, and took the
//     token's decimals from the client's symbol — so USDm dust recorded as "USDC" bought a real
//     bill. It now verifies the vault's PaymentReceived event against the stored row.
//   • The vend used the SETTLE request's body. Anything not visible on-chain — variation_code
//     (which data plan / cable package), phone, subscription type, email — could be swapped
//     after paying for something cheaper. The vend now reads only the intent row.
//
// Each on-chain hash can back at most one row: transactions.tx_hash is UNIQUE and the guard only
// lets a `preflight_` placeholder be renamed, so a hash already claimed elsewhere fails the
// claim with 23505 and is reported as PAYMENT_ALREADY_USED — never vended twice.
//
// Response contract with src/app/page.tsx is unchanged: it branches on `status` —
// 'SUCCESS' | 'TIMEOUT' (= "finishing in the background") | anything else (= failed).

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** What page.tsx's buildBackendPayload() sends, plus the per-call control fields. */
interface PayRequest {
  serviceID?: string; serviceCategory?: string; network?: string; billersCode?: string;
  amount?: string | number; nairaAmount?: string | number; token?: string; variation_code?: string;
  phone?: string; email?: string; wallet_address?: string; blockchain?: string; source_channel?: string;
  subscription_type?: string; meter_account_type?: string; customer_name?: string; customer_address?: string;
  foreignAmount?: string | number; displayAmount?: string;
  operator_id?: string | number; country_code?: string; product_type_id?: string | number;
  txHash?: string; intent_id?: string; preflight_hash?: string; intent_only?: boolean; cancel_intent?: boolean;
}

// How long settle waits for the receipt. The client only calls settle after its OWN receipt
// wait succeeded, so on a healthy RPC this returns immediately; the budget covers a lagging one.
const RECEIPT_WAIT_MS = 60_000;

function isPreflightId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('preflight_') && v.length <= 200;
}

async function alert(text: string) {
  try { await sendTelegramAlert(text); } catch { /* alerting must never change a payment outcome */ }
}

export async function POST(req: Request) {
  // 🛡️ THROTTLE — a normal payment costs 2 calls (intent, then settle), so 30/min per client is
  // far above any legitimate pattern while still bounding scripted abuse.
  const limited = await enforceRateLimit(req, 'pay', 30, 60);
  if (limited) return limited;

  try {
    const body = (await req.json()) as PayRequest;

    if (body.cancel_intent) return cancelIntent(body);
    if (body.intent_only) return createIntent(req, body);
    return settle(body);
  } catch {
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: "System error recording transaction." }, { status: 500 });
  }
}

// ── CANCEL ─────────────────────────────────────────────────────────────────────────────────
// Only ever means "I backed out before signing": an unsigned, still-PENDING preflight row. A
// real transaction hash can never be touched here (a tx_hash is public on-chain data).
async function cancelIntent(body: PayRequest) {
  const id = String(body.intent_id || body.preflight_hash || body.txHash || '');
  if (!isPreflightId(id)) {
    console.warn(`[Pay] Refused cancel_intent for non-preflight hash: ${String(id).slice(0, 24)}`);
    return NextResponse.json({ success: false, status: "CANCELLED", message: "Only an unsigned payment intent can be cancelled." }, { status: 400 });
  }
  await supabase.from('transactions').delete().eq('tx_hash', id).eq('status', 'PENDING');
  return NextResponse.json({ success: true, status: "CANCELLED" });
}

// ── INTENT ─────────────────────────────────────────────────────────────────────────────────
async function createIntent(req: Request, body: PayRequest) {
  const {
    serviceID, serviceCategory, network, billersCode, amount,
    token: tokenSymbol, variation_code, phone,
    nairaAmount, foreignAmount, displayAmount, wallet_address, subscription_type,
    operator_id, country_code, product_type_id, email,
    meter_account_type, blockchain,
    customer_name, customer_address, source_channel,
  } = body;

  // The server names the intent. A client-supplied `preflight_…` id is still honoured for one
  // release so a browser holding an older bundle keeps working — safely, because the write
  // below is an INSERT: it can only create that row, never overwrite one. Anything else in
  // txHash (above all a real 0x hash) is refused outright.
  const clientId = body.intent_id ?? body.preflight_hash ?? body.txHash;
  if (clientId !== undefined && clientId !== null && clientId !== '' && !isPreflightId(clientId)) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "A payment intent can't carry a transaction hash." }, { status: 400 });
  }
  const intentId = isPreflightId(clientId) ? clientId : `preflight_${randomUUID()}`;

  const vendAmount = Number(nairaAmount);
  if (!Number.isFinite(vendAmount) || vendAmount <= 0) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Invalid bill amount." }, { status: 400 });
  }

  const isForeign = serviceID === 'foreign-airtime';
  const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
  const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
  // ⚡ CBN STAMP DUTY — ₦50 fixed on electronic transfers of ₦10,000 and above. Charged into the
  // crypto amount like serviceFee, tracked in its own column (stamp_duty_ngn) — a regulatory
  // pass-through, not revenue.
  const stampDutyNgn = (serviceCategory === 'BANK' && vendAmount >= 10000) ? 50 : 0;

  // 1. RATE — server-side source of truth. Priced HERE, at intent time: the amount recorded on
  // this row is what settlement later requires the vault to have received.
  const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
  const baseRate = parseFloat(settingsData?.exchange_rate || "1500");

  // 1b. DISCOUNT — authoritative, server-computed. International requests send a dynamic
  // serviceCategory ("INTL AIRTIME", ...) that is normalised to the stable "INTERNATIONAL" key
  // the client also previews against, so a global campaign can't silently discount it.
  const discountServiceKey = String(serviceCategory || '').toUpperCase().startsWith('INTL') ? 'INTERNATIONAL' : serviceCategory;
  const destinationAccount = billersCode || phone || "N/A";
  const activeDiscount = await getActiveDiscountForService(discountServiceKey || null);
  const { discountNgn, discountPhone } = await computeDiscountNgn(vendAmount, activeDiscount, wallet_address, destinationAccount);

  const requiredCrypto = (vendAmount + serviceFee + stampDutyNgn - discountNgn) / baseRate;
  if (!(Number(amount) >= Number(requiredCrypto.toFixed(4)))) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Insufficient crypto paid." }, { status: 400 });
  }

  // ⚡ DUPLICATE ELECTRICITY GUARD — enforced before anything is signed (see src/lib/parity.ts;
  // the same guard MCP, the scheduler and chat share).
  if (serviceCategory === 'ELECTRICITY') {
    const dup = await isDuplicateElectricity(supabase, String(wallet_address || ''), destinationAccount, vendAmount);
    if (dup) {
      return NextResponse.json({
        success: false,
        status: 'DUPLICATE',
        message: `You already paid ₦${vendAmount.toLocaleString()} to meter ${destinationAccount} today. If you really meant to pay again, wait a moment and try again, or contact support.`,
      }, { status: 409 });
    }
  }

  // Best-effort client IP — captured ONLY when a discount applied, purely so the admin
  // dashboard can flag suspicious clusters for manual review. Never used to block anyone.
  const clientIp = discountNgn > 0
    ? (req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null)
    : null;

  const row = {
    tx_hash: intentId, request_id: getStrictRequestId(), service_category: serviceCategory, service_id: serviceID, variation_code: variation_code, network: network,
    // Canonical 'BASE' | 'CELO'. An omitted chain keeps the LEGACY meaning (Celo) rather than the
    // new default, same as every stored-row reader (src/lib/chain.ts resolveChain).
    blockchain: normalizeChainName(blockchain || LEGACY_RECORD_CHAIN), account_number: destinationAccount, phone: phone || null, amount_usdt: Number(amount),
    amount_naira: vendAmount, fee_naira: serviceFee, stamp_duty_ngn: stampDutyNgn, discount_ngn: discountNgn, discount_campaign_id: activeDiscount?.id || null,
    discount_phone: discountPhone, client_ip: clientIp,
    status: 'PENDING', wallet_address: (wallet_address || "UNKNOWN").toLowerCase(),
    customer_name: customer_name || null, customer_address: customer_address || null,
    source_channel: source_channel || 'WEB',
    token_used: tokenSymbol, meter_account_type: meter_account_type || null, customer_email: email || null,
    operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null, subscription_type: subscription_type || null,
    foreign_amount: foreignAmount || null, display_amount: displayAmount || null,
  };

  // 🔴 A failed write stops the flow before any signature is requested — otherwise the wallet
  // would be prompted for a payment with no row to attach to (crypto moved, app unaware).
  const { error } = await supabase.from('transactions').insert(row);
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "This payment was already started — refresh and try again." }, { status: 409 });
    }
    console.error('[Pay] intent insert failed:', error.message);
    await alert(`🚨 *PREFLIGHT WRITE FAILED*\nCouldn't create the intent row for a ${serviceCategory} payment — refused before any signature was requested.\n👤 Wallet: \`${wallet_address}\`\n🛑 Error: ${error.message}`);
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Couldn't start this payment — please try again or contact support." }, { status: 500 });
  }

  return NextResponse.json({ success: true, status: "PENDING", intent_id: intentId });
}

// ── SETTLE ─────────────────────────────────────────────────────────────────────────────────
async function settle(body: PayRequest) {
  const txHash = String(body.txHash || '').toLowerCase();
  if (!TX_HASH_RE.test(txHash)) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "A transaction hash is required." }, { status: 400 });
  }
  const intentId = body.intent_id ?? body.preflight_hash;
  if (intentId !== undefined && intentId !== null && intentId !== '' && !isPreflightId(intentId)) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Invalid payment intent." }, { status: 400 });
  }

  // Which row does this settle? The intent, if it still carries its placeholder — or, if the
  // Alchemy webhook already rescued it, the row that now carries this hash.
  const { data: byIntent } = isPreflightId(intentId)
    ? await supabase.from('transactions').select('*').eq('tx_hash', intentId).maybeSingle()
    : { data: null };
  const { data: byHash } = await supabase.from('transactions').select('*').eq('tx_hash', txHash).maybeSingle();

  // A DIFFERENT row already owns this hash while a fresh intent is presenting it: a replay.
  if (byHash && byIntent && byIntent.id !== byHash.id) {
    await alert(`🚨 *PAYMENT REPLAY BLOCKED*\nA settle tried to attach an already-claimed hash to a new intent.\nHash: \`${txHash}\`\nIntent: \`${intentId}\`\n👤 Intent wallet: \`${byIntent.wallet_address}\``);
    await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'PAYMENT_ALREADY_USED', api_response: `Settle presented ${txHash}, already attached to another transaction.` })
      .eq('tx_hash', intentId).eq('status', 'PENDING');
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', code: 'PAYMENT_ALREADY_USED', message: "That payment has already been used." }, { status: 409 });
  }

  // Otherwise the row carrying this hash IS this payment's row (the webhook rescued it, or an
  // earlier settle attached it while the chain was unreadable). Already settled -> answer from
  // it, never vend again. Still PENDING -> fall through and verify it now.
  const row = byIntent || byHash;
  if (!row) {
    // Money is on-chain (the client only settles after its receipt) but there's no row to
    // attach it to — the one case nothing downstream can recover by itself.
    await alert(`🚨 *PREFLIGHT RECONCILE FAILED*\nNo intent row for \`${intentId || '(none sent)'}\` when settling real tx \`${txHash}\`. Funds may be on-chain — this payment needs manual recovery.`);
    return NextResponse.json({ success: false, status: 'TIMEOUT', code: 'INTENT_NOT_FOUND', message: "We're confirming this payment in the background — check History shortly." }, { status: 404 });
  }

  if (row.status !== 'PENDING') {
    if (row.status === 'EXPIRED') {
      await alert(`🚨 *PAID AFTER INTENT EXPIRED*\nIntent \`${row.tx_hash}\` was expired by the cleanup sweep, then settled with real tx \`${txHash}\`. Needs manual vend-or-refund.\n👤 Wallet: \`${row.wallet_address}\`\n💰 ${row.amount_usdt} ${row.token_used}`);
      return NextResponse.json({ success: false, status: 'TIMEOUT', code: 'INTENT_EXPIRED', message: "This payment is being reviewed — check History shortly or contact support." }, { status: 409 });
    }
    return existingOutcome(row);
  }

  const explorerUrl = `${explorerBaseFor(row.blockchain)}/tx/${txHash}`;

  // 3. ON-CHAIN PROOF — every expected value comes from the ROW, none from this request.
  const proof = await verifyVaultPayment(txHash, {
    blockchain: row.blockchain,
    tokenSymbol: row.token_used,
    minAmountCrypto: row.amount_usdt,
    accountNumber: row.account_number,
    serviceId: row.service_id,
    walletAddress: row.wallet_address,
  }, { waitMs: RECEIPT_WAIT_MS });

  if (!proof.ok && UNDECIDED_PROOF_FAILURES.has(proof.code)) {
    // Couldn't read the chain — no verdict either way. Attach the hash (so the Alchemy webhook
    // and the reconcile sweep find this row by exact match), leave it PENDING, and let them
    // finish once the chain answers. Nothing is vended without a proof.
    const { error } = await supabase.from('transactions').update({ tx_hash: txHash })
      .eq('id', row.id).eq('status', 'PENDING');
    if (error?.code === '23505') {
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', code: 'PAYMENT_ALREADY_USED', message: "That payment has already been used." }, { status: 409 });
    }
    return NextResponse.json({ success: false, status: 'TIMEOUT', verifying: true, message: "Transaction verifying in background." }, { status: 202 });
  }

  if (!proof.ok) {
    // A definite verdict against this payment. The row keeps its placeholder: attaching a hash
    // that failed verification would let one row squat on a hash it has no claim to.
    const reverted = proof.code === 'REVERTED';
    await supabase.from('transactions').update({
      status: 'FAILED_VENDING',
      error_code: proof.code,
      api_response: `${proof.detail} (tx ${txHash})`.slice(0, 500),
    }).eq('id', row.id).eq('status', 'PENDING');
    await alert(reverted
      ? `🛑 *DOUBLE SPEND BLOCKED*\nUser ${row.wallet_address} tried to use a failed/reverted transaction!\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`
      : `🚨 *PAYMENT VERIFICATION FAILED — ${proof.code}*\n${proof.detail}\n👤 Wallet: \`${row.wallet_address}\`\n🛒 ${row.network} ${row.service_category}\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
    return NextResponse.json({
      success: false,
      status: 'FAILED_VENDING',
      code: proof.code,
      message: reverted ? "Transaction failed on the blockchain. Your funds were not deducted." : "This payment didn't match the bill it was made for.",
    }, { status: 400 });
  }

  // 4. CLAIM + LOCK — one conditional write: attach the proven hash, take PENDING -> PROCESSING,
  // issue the vend's request_id. If the webhook got here first it's no longer PENDING and
  // nothing matches; if another row already carries this hash the UNIQUE index refuses it.
  const vtRequestId = getStrictRequestId();
  const { data: locked, error: lockError } = await supabase.from('transactions')
    .update({ tx_hash: txHash, status: 'PROCESSING', request_id: vtRequestId })
    .eq('id', row.id)
    .eq('status', 'PENDING')
    .select()
    .maybeSingle();

  if (lockError?.code === '23505') {
    await alert(`🚨 *PAYMENT REPLAY BLOCKED*\nVerified hash \`${txHash}\` is already attached to another transaction.\n👤 Wallet: \`${row.wallet_address}\``);
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', code: 'PAYMENT_ALREADY_USED', message: "That payment has already been used." }, { status: 409 });
  }
  if (!locked || lockError) {
    return NextResponse.json({ success: true, status: "TIMEOUT", message: "Vending handled by background webhook." });
  }

  // Points in executeVend are priced at the current rate, as before.
  const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
  const baseRate = parseFloat(settingsData?.exchange_rate || "1500");

  // 5. VEND — strictly from the stored row (shared with the x402 rail — src/lib/vend.ts).
  const vendResult = await executeVend(vendInputFromRow(locked, { txHash, explorerUrl, baseRate, vtRequestId }));

  return NextResponse.json(vendResult);
}

/**
 * The answer for a row that has already been settled — never a second vend.
 *
 * 🔴 Deliberately carries NO purchased_code / units / request_id. Anyone can reach this with a
 * tx hash read off a block explorer, and the meter token / exam PIN is a bearer secret. The
 * payer gets it from the vend response itself, from History (signature-gated) and by email.
 */
function existingOutcome(row: { status: string }) {
  switch (row.status) {
    case 'SUCCESS':
      return NextResponse.json({ success: true, status: 'SUCCESS' });
    case 'PENDING':
    case 'PROCESSING':
      return NextResponse.json({ success: true, status: 'TIMEOUT', message: "Vending handled by background webhook." });
    default:
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: row.status === 'REFUNDED' ? "This payment was refunded." : "This payment could not be completed." });
  }
}
