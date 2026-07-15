import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase'; 
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass'; 
import { buildReceiptEmail } from '@/lib/receiptEmail';
import { enqueueRefund } from '@/lib/refunds';
import { Resend } from 'resend';
import { createPublicClient, http, decodeFunctionData, parseUnits } from 'viem';
import { base, baseSepolia, celo, celoSepolia } from 'viem/chains';

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

const error_messages: Record<string, string> = {
    "011": "Invalid details. Check your phone/meter number.",
    "014": "Daily limit exceeded with this provider.",
    "016": "Provider network is unstable. Please try again.",
    "018": "Service temporarily unavailable.", 
    "030": "Provider network is down.",
    "400": "Transaction failed due to a system error."
};

const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];

// 🔐 SECURITY: request_id is the lookup key for a transaction's `purchased_code`
// (electricity token / exam PIN — a bearer secret). It MUST NOT be predictable.
//
// This previously used Math.random(), which is not a CSPRNG: V8's generator state is
// recoverable from a few observed outputs, and the first 12 chars are just a timestamp.
// That made IDs guessable, and therefore other customers' tokens reachable.
//
// crypto.randomInt() is a CSPRNG and unbiased. 12 chars over a 36-char alphabet
// = 36^12 ≈ 4.7e18 — not brute-forceable.
//
// NOTE: this duplicates generateRequestId() in src/lib/vtpass.js. Both are now secure,
// but the duplication should be removed (see AUDIT_REPORT_V2.md, item M-2 / #7).
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

function getStrictRequestId() {
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

export async function POST(req: Request) {
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
    if (cancel_intent) {
        const hashToDelete = preflight_hash || txHash;
        await supabase.from('transactions').delete().eq('tx_hash', hashToDelete);
        return NextResponse.json({ success: true, status: "CANCELLED" });
    }

    const requestedNaira = parseFloat(nairaAmount);
    const isForeign = serviceID === 'foreign-airtime';
    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira; 
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
    const requiredCrypto = (vendAmount + serviceFee) / baseRate;

    if (parseFloat(amount) < parseFloat(requiredCrypto.toFixed(4))) {
        return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Insufficient crypto paid." }, { status: 400 });
    }

    // 2. THE SAFETY NET / ATOMIC LOCK
    const dbPayload = {
      tx_hash: txHash, request_id: vtRequestId, service_category: serviceCategory, service_id: serviceID, variation_code: variation_code, network: network, 
      blockchain: blockchain || "CELO", account_number: billersCode || phone || "N/A", phone: phone || null, amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount, fee_naira: serviceFee, status: 'PENDING', wallet_address: (wallet_address || "UNKNOWN").toLowerCase(),
      customer_name: customer_name || null, customer_address: customer_address || null,
      source_channel: source_channel || 'WEB',
      token_used: tokenSymbol, meter_account_type: meter_account_type || null, customer_email: email || null,
      operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null, subscription_type: subscription_type || null,
      foreign_amount: foreignAmount || null, display_amount: displayAmount || null // ⚡ Save for background webhook use
    };

    if (intent_only) {
        await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });
        return NextResponse.json({ success: true, status: "PENDING" });
    }

    if (preflight_hash) {
        await supabase.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', preflight_hash);
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
            const paddedExpectedContract = "0x000000000000000000000000" + expectedLower.substring(2);
            // Find the ERC-20 Transfer log whose recipient (topic[2]) is the AbaPay contract.
            const transferLog = receipt.logs.find((log: any) => log.topics && log.topics.length >= 3 && log.topics[2]?.toLowerCase() === paddedExpectedContract);

            if (!transferLog) {
                 await sendTelegramAlert(`🚨 *SMART WALLET FRAUD DETECTED*\nFunds did not reach AbaPay contract.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Funds not received." }, { status: 400 });
            }

            // 🔐 AMOUNT ENFORCEMENT FOR SPONSORED/SMART-WALLET PATH
            // The transfer amount is the non-indexed `value` in the log data. Previously this
            // path confirmed only that *a* transfer happened — not how much — which let a
            // sponsored/smart-wallet user pay a trivial amount and request a large vend.
            try {
                const tokenDecimals = (tokenSymbol === 'cUSD' || tokenSymbol === 'USDm') ? 18 : 6;
                const paidWei = BigInt(transferLog.data as string);
                const requiredWei = parseUnits(requiredCrypto.toFixed(tokenDecimals), tokenDecimals);
                // Allow a tiny rounding tolerance (matches the EOA path's philosophy).
                const shortfall = requiredWei > paidWei ? requiredWei - paidWei : BigInt(0);
                const tolerance = parseUnits("0.01", tokenDecimals); // 1 cent grace for rounding
                if (shortfall > tolerance) {
                    await sendTelegramAlert(`🚨 *SPONSORED UNDERPAYMENT BLOCKED*\nUser ${wallet_address} paid less than required via smart wallet.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Amount mismatch detected." }, { status: 400 });
                }
            } catch (amountErr) {
                await sendTelegramAlert(`🚨 *SPONSORED AMOUNT UNVERIFIABLE*\nCould not decode transfer amount — refusing to vend.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Could not verify payment amount." }, { status: 400 });
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

    // 5. CONSTRUCT VTPASS PAYLOAD
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    // ⚡ INTERNATIONAL FIX: Use foreignAmount and Admin phone number for SMS field
    const safeAmount = isForeign ? parseFloat(foreignAmount || "1") : vendAmount;
    const safePhone = isForeign ? "08168811821" : (phone || billersCode);

    let vtpassPayload: any = { 
        request_id: vtRequestId, 
        serviceID: serviceID, 
        amount: safeAmount, 
        phone: safePhone 
    };

    if (isForeign) {
        vtpassPayload.billersCode = billersCode; 
        vtpassPayload.variation_code = variation_code; 
        vtpassPayload.operator_id = operator_id?.toString();          // ⚡ REQUIRED STRING
        vtpassPayload.country_code = country_code; 
        vtpassPayload.product_type_id = product_type_id?.toString();  // ⚡ REQUIRED STRING
        vtpassPayload.email = email || "support@abapay.com";
    } else {
        if (['DATA', 'ELECTRICITY', 'BANK'].includes(serviceCategory)) { vtpassPayload.billersCode = billersCode; vtpassPayload.variation_code = variation_code; } 
        else if (serviceCategory === 'EDUCATION') { vtpassPayload.variation_code = variation_code; if (serviceID === 'jamb') vtpassPayload.billersCode = billersCode; } 
        else if (serviceCategory === 'INTERNET') { vtpassPayload.billersCode = billersCode; vtpassPayload.variation_code = variation_code; if (serviceID === 'spectranet') vtpassPayload.quantity = 1; } 
        else if (serviceCategory === 'CABLE') {
            vtpassPayload.billersCode = billersCode;
            if (['dstv', 'gotv'].includes(serviceID)) { vtpassPayload.subscription_type = subscription_type; if (subscription_type === 'change') { vtpassPayload.variation_code = variation_code; vtpassPayload.quantity = 1; } } 
            else { vtpassPayload.variation_code = variation_code; }
        }
    }

    // 6. CALL VTPASS DIRECTLY
    let payRes, payData;
    try {
        payRes = await fetch(`${baseUrl}/pay`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(vtpassPayload) });
        payData = await payRes.json();
    } catch (e: any) {
        await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash); 
        return NextResponse.json({ success: true, status: "TIMEOUT", message: "Network slow. Finishing in background." }); 
    }

    // 7. HANDLE VTPASS RESPONSE & RETURN INSTANTLY
    if (payData.code === '000' || payData.code === '099') {
        let dbPurchasedCode = null; let vendedUnits = null; let alertTokenRef = "Success";

        if (serviceCategory === 'ELECTRICITY' && !isForeign) {
            dbPurchasedCode = payData.purchased_code || payData.token || payData.content?.transactions?.token || payData.content?.transactions?.purchased_code || null;
            if (!dbPurchasedCode) { const tokenMatch = JSON.stringify(payData).match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i); if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, ''); }
            alertTokenRef = dbPurchasedCode || "Processing Token";
            vendedUnits = payData.units?.toString() || payData.content?.transactions?.units?.toString() || null;
        } else if (serviceCategory === 'EDUCATION') {
            dbPurchasedCode = payData.purchased_code || payData.Pin || null; alertTokenRef = dbPurchasedCode || "Processing PIN";
        } else { alertTokenRef = payData.content?.transactions?.transactionId || payData.requestId || "Success"; }

        await supabase.from('transactions').update({ status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits }).eq('tx_hash', txHash);

        try {
            // ⚡ RECEIPT FIX: Display correct currency/amount in Telegram
            await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n📲 *Source:* ${channelBadge(source_channel)}\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Amount Paid:* ${displayAmount || `₦${vendAmount}`}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode}\n🧾 *Ref:* ${alertTokenRef}\n🔍 *Explorer:* ${explorerUrl}`);
        } catch (tgError) {
            console.error("Telegram Success Alert Error:", tgError);
        }

        if (serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION') {
            const typeLabel = serviceCategory === 'ELECTRICITY' ? 'Token' : 'PIN';
            sendAbaPaySms(phone || billersCode, `AbaPay: Your ${network || serviceCategory} ${typeLabel} is ${alertTokenRef}. Amount: N${vendAmount}. Thank you.`).catch(()=>{});
        }

        if (email) {
            const premiumHtml = buildReceiptEmail({
                displayAmount: displayAmount || `₦${vendAmount.toLocaleString()}`,
                serviceLabel: `${network} ${serviceCategory}`,
                accountNumber: billersCode || phone,
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
                    html: premiumHtml
                });
            } catch (emailError) {
                console.error("Resend API Error:", emailError);
            }
        }

        const points = Number((vendAmount / baseRate).toFixed(2));
        if (points > 0 && wallet_address) {
            supabase.rpc('award_transaction_points', { target_wallet: wallet_address.toLowerCase(), points_to_add: points }).then(({ error }) => {
                if (error) console.error("Points Error:", error.message);
            });
        }

        return NextResponse.json({ success: true, status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits, request_id: vtRequestId });
    } else {
        const friendlyMessage = error_messages[payData.code as string] || "Service is temporarily undergoing maintenance.";
        // ⚡ ADMIN FIX: Unified FAILED_VENDING status
        await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: payData.code, api_response: payData.response_description }).eq('tx_hash', txHash);
        try {
            await sendTelegramAlert(`❌ *VENDING REJECTED*\n📲 *Source:* ${channelBadge(source_channel)}\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode}\n🚨 *Admin Error:* Code ${payData.code} - ${payData.response_description}\n🗣 *User Message:* ${friendlyMessage}\n🔍 *Explorer:* ${explorerUrl}`);
        } catch (tgError) {
            console.error("Telegram Failure Alert Error:", tgError);
        }

        // ⚡ AUTO-QUEUE THE REFUND ⚡
        //
        // We are ONLY here because the on-chain payment was already verified above — so the
        // user's crypto IS in our vault, and they received nothing. They are owed money.
        //
        // Previously this just sat as FAILED_VENDING until a human happened to notice. That
        // is untenable once an agent can transact unattended: a user could be auto-charged
        // on a 3am schedule for a service that failed, with nobody watching.
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
            console.error('[Pay] Failed to queue refund:', refundErr);
        }

        return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: `${friendlyMessage} Your funds are being refunded — you don't need to do anything.` });
    }

  } catch (error: any) {
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: "System error recording transaction." }, { status: 500 });
  }
}
