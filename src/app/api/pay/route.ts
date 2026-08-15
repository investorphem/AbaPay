import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { getActiveDiscountForService, computeDiscountNgn } from '@/lib/discounts';
import { isDuplicateElectricity } from '@/lib/parity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createPublicClient, http, decodeFunctionData, decodeEventLog, parseUnits } from 'viem';
import { base, baseSepolia, celo, celoSepolia } from 'viem/chains';
import { resolveTokenOnChain, normalizeChainName, LEGACY_RECORD_CHAIN } from '@/constants';

const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];

// Minimal ERC-20 Transfer ABI — used to decode (not merely pattern-match) the token transfer
// on the sponsored/smart-wallet settlement path below. Same shape /api/admin/refund uses.
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
  // 🛡️ THROTTLE — this route had no rate limit at all, despite being the endpoint that writes
  // ledger rows, reads chain state over RPC, and (below) deletes pre-flight intents. A normal
  // payment costs 2 calls (intent_only, then the real settle), so 30/min per client is far
  // above any legitimate pattern while still bounding scripted abuse.
  const limited = await enforceRateLimit(req, 'pay', 30, 60);
  if (limited) return limited;

  try {
    const body = await req.json();
    const { 
      serviceID, serviceCategory, network, billersCode, amount, 
      token: tokenSymbol, txHash, variation_code, phone, 
      nairaAmount, foreignAmount, displayAmount, wallet_address, subscription_type, // ⚡ ADDED foreignAmount & displayAmount
      operator_id, country_code, product_type_id, email,
      meter_account_type, blockchain,
      customer_name, customer_address, // ⚡ From VTpass merchant-verify (electricity/bank)
      source_channel,                  // ⚡ WEB | TELEGRAM | WHATSAPP | X | SCHEDULE
      intent_only, preflight_hash, cancel_intent 
    } = body;

    // ⚡ FIX 1: INSTANT CANCELLATION INTERCEPTOR ⚡
    //
    // 🔴 THE BUG THIS FIXES: this deleted ANY row matching the supplied tx_hash — no
    // authentication, no ownership check, no status check, and /api/pay has no rate limit.
    // A tx_hash is PUBLIC on-chain data (anyone can read the vault's transfers on an explorer),
    // so this was an open endpoint for erasing other people's completed transactions: receipts,
    // refund_queue linkage, points history, the ledger the admin dashboard reads. Worse, it
    // could delete a live PENDING row mid-payment, recreating exactly the "crypto moved but the
    // app has no record of it" failure the preflight guards further down exist to prevent.
    //
    // A cancel only ever legitimately means "I backed out before signing," so it is now scoped
    // to that and only that: an unsigned `preflight_` intent that is still PENDING. A real
    // transaction hash (0x…) can no longer be touched here at all.
    if (cancel_intent) {
        const hashToDelete = String(preflight_hash || txHash || '');

        if (!hashToDelete.startsWith('preflight_')) {
            console.warn(`[Pay] Refused cancel_intent for non-preflight hash: ${hashToDelete.slice(0, 24)}`);
            return NextResponse.json({ success: false, status: "CANCELLED", message: "Only an unsigned payment intent can be cancelled." }, { status: 400 });
        }

        await supabase
            .from('transactions')
            .delete()
            .eq('tx_hash', hashToDelete)
            .eq('status', 'PENDING');

        return NextResponse.json({ success: true, status: "CANCELLED" });
    }

    const requestedNaira = parseFloat(nairaAmount);
    const isForeign = serviceID === 'foreign-airtime';
    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira;
    // ⚡ CBN STAMP DUTY — ₦50 fixed, mandated on electronic transfers of ₦10,000 and above.
    // Charged into the crypto amount like serviceFee, but tracked in its own column
    // (stamp_duty_ngn) rather than fee_naira — it's a regulatory pass-through, not revenue,
    // and never surfaced in any receipt/history UI (see page.tsx's cryptoToCharge comment).
    const stampDutyNgn = (serviceCategory === 'BANK' && vendAmount >= 10000) ? 50 : 0;
    const vtRequestId = getStrictRequestId();

    // ⚡ SMART EXPLORER URL GENERATOR ⚡
    const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "mainnet" || process.env.NEXT_PUBLIC_NETWORK === "celo" || process.env.NEXT_PUBLIC_NETWORK === "base";
    let explorerBase = isMainnet ? "https://celoscan.io" : "https://alfajores.celoscan.io";
    if (blockchain === 'BASE') {
        explorerBase = isMainnet ? "https://basescan.org" : "https://sepolia.basescan.org";
    }
    const explorerUrl = `${explorerBase}/tx/${txHash}`;

    // 1. RATE VERIFICATION (Security Check)
    const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
    const baseRate = parseFloat(settingsData?.exchange_rate || "1500");

    // 1b. DISCOUNT — authoritative, server-computed. serviceCategory here is the web app's
    // uiCategory (AIRTIME/INTERNET/ELECTRICITY/CABLE/BANK/EDUCATION) — already the same
    // canonical key set src/lib/discounts.ts matches campaigns against, no mapping needed.
    //
    // 🔴 THE BUG THIS FIXES: international requests send a DYNAMIC serviceCategory
    // ("INTL AIRTIME", "INTL DATA", ...) that never matched any admin-configured "services"
    // list — meaning a campaign scoped to specific services correctly excluded international,
    // but a GLOBAL campaign (no services restriction) still matched it via the "applies to
    // everything" fallback in getActiveDiscountForService, silently discounting an
    // international payment that the WEB APP's own preview never showed or accounted for
    // (it explicitly refused to compute a discount for international at all). Normalizing to
    // the same stable "INTERNATIONAL" key the client now also previews against means both
    // sides can only ever agree, and admins can explicitly include/exclude it like any other
    // service.
    const discountServiceKey = String(serviceCategory || '').toUpperCase().startsWith('INTL') ? 'INTERNATIONAL' : serviceCategory;
    const destinationAccount = billersCode || phone || "N/A";
    const activeDiscount = await getActiveDiscountForService(discountServiceKey);
    const { discountNgn, discountPhone } = await computeDiscountNgn(vendAmount, activeDiscount, wallet_address, destinationAccount);

    const requiredCrypto = (vendAmount + serviceFee + stampDutyNgn - discountNgn) / baseRate;

    if (parseFloat(amount) < parseFloat(requiredCrypto.toFixed(4))) {
        return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Insufficient crypto paid." }, { status: 400 });
    }

    // ⚡ Best-effort client IP — captured ONLY when a discount actually applied (never on an
    // ordinary transaction), purely to let the admin dashboard flag suspicious clusters (one IP,
    // many wallets, same campaign) for manual review. Never used to block anyone automatically.
    const clientIp = discountNgn > 0
      ? (req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null)
      : null;

    // 2. THE SAFETY NET / ATOMIC LOCK
    const dbPayload = {
      tx_hash: txHash, request_id: vtRequestId, service_category: serviceCategory, service_id: serviceID, variation_code: variation_code, network: network,
      // Stored canonical ('BASE' | 'CELO'). The frontend used to send the raw viem chain name,
      // so testnet rows held "BASE SEPOLIA" and read back as Celo. The empty case keeps the
      // LEGACY meaning rather than the new default — this row describes a payment that has
      // ALREADY happened on some chain, and guessing Base for a caller that omitted the field
      // would send the webhook looking for the receipt on the wrong one.
      blockchain: normalizeChainName(blockchain || LEGACY_RECORD_CHAIN), account_number: destinationAccount, phone: phone || null, amount_usdt: parseFloat(amount),
      amount_naira: vendAmount, fee_naira: serviceFee, stamp_duty_ngn: stampDutyNgn, discount_ngn: discountNgn, discount_campaign_id: activeDiscount?.id || null,
      discount_phone: discountPhone, client_ip: clientIp,
      status: 'PENDING', wallet_address: (wallet_address || "UNKNOWN").toLowerCase(),
      customer_name: customer_name || null, customer_address: customer_address || null,
      source_channel: source_channel || 'WEB',
      token_used: tokenSymbol, meter_account_type: meter_account_type || null, customer_email: email || null,
      operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null, subscription_type: subscription_type || null,
      foreign_amount: foreignAmount || null, display_amount: displayAmount || null // ⚡ Save for background webhook use
    };

    if (intent_only) {
        // ⚡ DUPLICATE ELECTRICITY GUARD — server-side, enforced. The web app already warns
        // client-side (page.tsx's hasPendingDuplicate/electricityDailyDuplicate) but that was
        // ONLY a notification — a "PROCEED ANYWAY" click sailed straight through with no
        // server-side check at all. This runs pre-signature (intent_only fires before the
        // wallet is even prompted), so a real duplicate is stopped before anything is signed
        // or spent — unlike a check placed after tx confirmation further down, which would be
        // too late (money already moved) to do anything but refund. Same guard MCP/scheduler/
        // chat now all share (src/lib/parity.ts).
        if (serviceCategory === 'ELECTRICITY') {
          const dup = await isDuplicateElectricity(supabase, wallet_address, destinationAccount, vendAmount);
          if (dup) {
            return NextResponse.json({
              success: false,
              status: 'DUPLICATE',
              message: `You already paid ₦${vendAmount.toLocaleString()} to meter ${destinationAccount} today. If you really meant to pay again, wait a moment and try again, or contact support.`,
            }, { status: 409 });
          }
        }

        // 🔴 THE BUG THIS FIXES: this write's result was never checked. If the upsert failed
        // (bad column value, transient DB error, whatever) the response still unconditionally
        // said `{success:true, status:"PENDING"}` — so the frontend proceeded to prompt the
        // REAL payBill signature with no row for it to ever attach to. The user's crypto moved
        // on-chain, but the app never knew the payment existed at all: no ledger entry, no
        // Telegram alert, nothing for the reconcile sweep to find later either (it only scans
        // EXISTING rows). Silent from end to end. Now a failed write stops the flow before any
        // signature is requested, exactly like the electricity duplicate guard just above.
        const { error: intentError } = await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });
        if (intentError) {
            console.error('[Pay] intent_only upsert failed:', intentError.message, JSON.stringify(dbPayload).slice(0, 500));
            try {
                await sendTelegramAlert(`🚨 *PREFLIGHT WRITE FAILED*\nCouldn't create the intent row for a ${serviceCategory} payment — refused before any signature was requested.\n👤 Wallet: \`${wallet_address}\`\n🛑 Error: ${intentError.message}`);
            } catch {}
            return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Couldn't start this payment — please try again or contact support." }, { status: 500 });
        }
        return NextResponse.json({ success: true, status: "PENDING" });
    }

    if (preflight_hash) {
        const { data: reconciled, error: reconcileError } = await supabase.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', preflight_hash).select();
        // 🔴 SAME CLASS OF BUG: if the preflight row from the intent_only step above doesn't
        // exist (e.g. it silently failed before this fix, or a race), this update matches zero
        // rows and nothing here noticed — the on-chain payment then proceeds with no DB row to
        // attach to, exactly the "money moved, app has no idea" failure the user hit. Now it's
        // impossible to miss: real money is on-chain by this point (txHash is a REAL hash, not
        // a preflight placeholder), so this alerts rather than silently letting the atomic lock
        // below fail the exact same way a moment later.
        if (reconcileError || !reconciled || reconciled.length === 0) {
            console.error('[Pay] Failed to reconcile preflight row', preflight_hash, '->', txHash, reconcileError?.message);
            try {
                await sendTelegramAlert(`🚨 *PREFLIGHT RECONCILE FAILED*\nNo preflight row found for \`${preflight_hash}\` when attaching real tx \`${txHash}\`. Funds are already on-chain — this payment needs manual recovery.\n👤 Wallet: \`${wallet_address}\`\n🔗 \`${txHash}\``);
            } catch {}
        }
    }

    // 3. ON-CHAIN VERIFICATION (Smart Wallet & Payload Tamper Check)
    try {
        const activeChain = blockchain === 'BASE' ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);

        let rpcUrl = activeChain.rpcUrls.default.http[0];
        if (activeChain.id === celo.id) rpcUrl = "https://forno.celo.org";
        if (activeChain.id === base.id) rpcUrl = "https://mainnet.base.org";

        const publicClient = createPublicClient({ chain: activeChain, transport: http(rpcUrl) });

        const receipt = await publicClient.waitForTransactionReceipt({ 
            hash: txHash as `0x${string}`,
            confirmations: 1,
            timeout: 60000 
        });

        if (receipt.status !== 'success') {
            await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'REVERTED', api_response: 'Transaction failed on-chain' }).eq('tx_hash', txHash);
            await sendTelegramAlert(`🛑 *DOUBLE SPEND BLOCKED*\nUser ${wallet_address} tried to use a failed/reverted transaction!\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
            return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Transaction failed on the blockchain. Your funds were not deducted." }, { status: 400 });
        }

        const expectedContract = blockchain === 'BASE' 
            ? (process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS)
            : (process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS);

        const txTo = receipt.to?.toLowerCase() || "";
        const expectedLower = expectedContract?.toLowerCase() || "";
        let isSmartWallet = false;

        if (txTo !== expectedLower) {
            const entryPoints = [ "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032" ];
            if (entryPoints.includes(txTo)) {
                isSmartWallet = true;
            } else {
                 await sendTelegramAlert(`🚨 *FRAUD ATTEMPT DETECTED*\nUser ${wallet_address} submitted a txHash sent to the wrong contract.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Invalid contract destination." }, { status: 400 });
            }
        }

        if (!isSmartWallet) {
            const transaction = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
            if (!transaction.input) return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "No contract data found." }, { status: 400 });

            const decoded = decodeFunctionData({ abi: ABAPAY_ABI, data: transaction.input });
            if (!decoded.args || decoded.args.length < 4) return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Invalid contract payload structure." }, { status: 400 });

            const chainServiceType = decoded.args[1] as string;
            const chainAccountNumber = decoded.args[2] as string;
            const chainAmountWei = decoded.args[3] as bigint;
            const expectedAccount = billersCode || phone;

            if (chainServiceType !== serviceID || chainAccountNumber !== expectedAccount) {
                await sendTelegramAlert(`🚨 *TAMPERING BLOCKED*\nUser ${wallet_address} altered the payload!\nChain Service: ${chainServiceType} | Requested: ${serviceID}\nChain Account: ${chainAccountNumber} | Requested: ${expectedAccount}\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Payload mismatch detected." }, { status: 400 });
            }

            const tokenDecimals = (tokenSymbol === 'cUSD' || tokenSymbol === 'USDm') ? 18 : 6;
            const expectedWei = parseUnits(amount.toString(), tokenDecimals);
            const diff = chainAmountWei > expectedWei ? chainAmountWei - expectedWei : expectedWei - chainAmountWei;

            if (diff > BigInt(10)) {
                 await sendTelegramAlert(`🚨 *AMOUNT TAMPERING BLOCKED*\nUser ${wallet_address} altered the price payload.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Amount mismatch detected." }, { status: 400 });
            }
        } else {
            // 🔐 SPONSORED / SMART-WALLET SETTLEMENT — WHICH token, to WHOM, for HOW MUCH.
            //
            // 🔴 THE BUG THIS FIXES: this used to scan every log in the receipt for one whose
            // topics[2] happened to equal the padded AbaPay address, and then read the amount
            // straight out of `log.data`. It never checked WHICH contract emitted that log, nor
            // that the log was even a Transfer event. Because anyone can route a UserOperation
            // through the ERC-4337 EntryPoint (which is what puts us on this branch at all), an
            // attacker could deploy a worthless ERC-20, transfer a huge balance of it to the
            // vault inside their UserOp, and have that fake amount read back as `paidWei` —
            // clearing the amount check and earning a real, delivered vend for nothing.
            //
            // /api/webhook (which filters on `log.address` before decoding PaymentReceived) and
            // /api/admin/refund (which filters on the expected token address) both already got
            // this right; this path was the one left behind. It now resolves the token the
            // record actually claims was paid, and only accepts a genuine ERC-20 Transfer
            // emitted BY that token contract, addressed TO the AbaPay vault.
            const expectedToken = resolveTokenOnChain(tokenSymbol, blockchain || 'CELO', isMainnet);
            if (!expectedToken) {
                await sendTelegramAlert(`🚨 *SPONSORED UNKNOWN TOKEN*\nCould not resolve token \`${tokenSymbol}\` on ${blockchain || 'CELO'} — refusing to vend.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Unsupported payment token." }, { status: 400 });
            }

            let paidWei: bigint | null = null;
            for (const log of receipt.logs) {
                // Must have been emitted BY the stablecoin contract itself — this is the check
                // whose absence made every other check on this branch meaningless.
                if (log.address?.toLowerCase() !== expectedToken.address) continue;
                try {
                    const decoded: any = decodeEventLog({ abi: ERC20_TRANSFER_ABI, data: log.data, topics: log.topics });
                    if (decoded.eventName !== 'Transfer') continue;
                    if (String(decoded.args.to).toLowerCase() !== expectedLower) continue;
                    paidWei = BigInt(decoded.args.value);
                    break;
                } catch { /* not a Transfer log from this token */ }
            }

            if (paidWei === null) {
                 await sendTelegramAlert(`🚨 *SMART WALLET FRAUD DETECTED*\nNo genuine ${tokenSymbol} transfer to the AbaPay contract found in this transaction.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Funds not received." }, { status: 400 });
            }

            // 🔐 AMOUNT ENFORCEMENT — decimals come from the resolved token, not a guess based
            // on the client-supplied symbol.
            const requiredWei = parseUnits(requiredCrypto.toFixed(expectedToken.decimals), expectedToken.decimals);
            const tolerance = parseUnits("0.01", expectedToken.decimals); // 1 cent grace for rounding
            const shortfall = requiredWei > paidWei ? requiredWei - paidWei : BigInt(0);
            if (shortfall > tolerance) {
                await sendTelegramAlert(`🚨 *SPONSORED UNDERPAYMENT BLOCKED*\nUser ${wallet_address} paid less than required via smart wallet.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Amount mismatch detected." }, { status: 400 });
            }
        }
    } catch (error) {
        return NextResponse.json({ success: true, status: 'TIMEOUT', message: "Transaction verifying in background." });
    }

    // 4. ATOMIC LOCK
    const { data: lockedRecord, error: lockError } = await supabase
      .from('transactions')
      .update({ status: 'PROCESSING', request_id: vtRequestId })
      .eq('tx_hash', txHash) 
      .eq('status', 'PENDING')
      .select()
      .single();

    if (!lockedRecord || lockError) {
        return NextResponse.json({ success: true, status: "TIMEOUT", message: "Vending handled by background webhook." });
    }

    // 5. VEND (shared with the x402 settlement path — see src/lib/vend.ts)
    const vendResult = await executeVend({
        vtRequestId, txHash, serviceID, serviceCategory, network, billersCode, phone,
        variation_code, subscription_type, amount, tokenSymbol, vendAmount, displayAmount,
        foreignAmount, isForeign, operator_id, country_code, product_type_id, email,
        wallet_address, blockchain, source_channel, customer_name, customer_address,
        baseRate, explorerUrl,
    });

    return NextResponse.json(vendResult);

  } catch (error: any) {
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: "System error recording transaction." }, { status: 500 });
  }
}
