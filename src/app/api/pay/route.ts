import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase'; 
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass'; 
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

function getStrictRequestId() {
  const date = new Date();
  const lagosTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const [datePart, timePart] = lagosTime.split(', ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute] = timePart.split(':');
  const safeHour = hour === '24' ? '00' : hour;
  const randomString = Math.random().toString(36).substring(2, 10);
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
      amount_naira: vendAmount, fee_naira: serviceFee, status: 'PENDING', wallet_address: wallet_address || "UNKNOWN",
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
            const foundTransfer = receipt.logs.some((log: any) => log.topics && log.topics.length >= 3 && log.topics[2]?.toLowerCase() === paddedExpectedContract);

            if (!foundTransfer) {
                 await sendTelegramAlert(`🚨 *SMART WALLET FRAUD DETECTED*\nFunds did not reach AbaPay contract.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Funds not received." }, { status: 400 });
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
            await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Amount Paid:* ${displayAmount || `₦${vendAmount}`}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode}\n🧾 *Ref:* ${alertTokenRef}\n🔍 *Explorer:* ${explorerUrl}`);
        } catch (tgError) {
            console.error("Telegram Success Alert Error:", tgError);
        }

        if (serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION') {
            const typeLabel = serviceCategory === 'ELECTRICITY' ? 'Token' : 'PIN';
            sendAbaPaySms(phone || billersCode, `AbaPay: Your ${network || serviceCategory} ${typeLabel} is ${alertTokenRef}. Amount: N${vendAmount}. Thank you.`).catch(()=>{});
        }

        if (email) {
            const premiumHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fdfbf7; padding: 40px 20px;">
              <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                <div style="background-color: #111114; padding: 40px 20px; text-align: center; border-bottom: 4px solid #10b981;">
                  <img src="https://abapays.com/logo.png" alt="AbaPay" style="height: 48px; width: auto;" />
                </div>
                <div style="padding: 40px 30px;">
                  <p style="font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 8px 0;">Transaction Successful</p>
                  <h2 style="font-size: 36px; font-weight: 900; color: #0f172a; margin: 0 0 32px 0; letter-spacing: -1px;">${displayAmount || `₦${vendAmount.toLocaleString()}`}</h2>
                  <div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
                    <div style="display: table-cell; width: 40%; font-size: 13px; color: #64748b;">Service</div>
                    <div style="display: table-cell; width: 60%; font-size: 13px; font-weight: 600; color: #334155; text-align: right; text-transform: uppercase;">${network} ${serviceCategory}</div>
                  </div>
                  <div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
                    <div style="display: table-cell; width: 40%; font-size: 13px; color: #64748b;">Account / Phone</div>
                    <div style="display: table-cell; width: 60%; font-size: 13px; font-weight: 600; color: #334155; text-align: right;">${billersCode || phone}</div>
                  </div>
                  <div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
                    <div style="display: table-cell; width: 40%; font-size: 13px; color: #64748b;">Crypto Charged</div>
                    <div style="display: table-cell; width: 60%; font-size: 13px; font-weight: 600; color: #334155; text-align: right;">${amount} ${tokenSymbol || 'USD₮'}</div>
                  </div>
                  <div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
                    <div style="display: table-cell; width: 30%; font-size: 13px; color: #64748b;">Transaction Hash</div>
                    <div style="display: table-cell; width: 70%; font-size: 12px; font-weight: 500; color: #334155; text-align: right; word-break: break-all; font-family: monospace;">${txHash}</div>
                  </div>
                  ${dbPurchasedCode ?
                  `<div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
                    <div style="display: table-cell; width: 40%; font-size: 13px; color: #64748b;">Token / PIN</div>
                    <div style="display: table-cell; width: 60%; font-size: 14px; font-weight: 800; color: #10b981; text-align: right; letter-spacing: 1px;">Token : ${dbPurchasedCode}</div>
                  </div>`
                  :
                  `<div style="border-top: 1px solid #e2e8f0; padding: 16px 0; display: table; width: 100%;">
                    <div style="display: table-cell; width: 40%; font-size: 13px; color: #64748b;">Reference ID</div>
                    <div style="display: table-cell; width: 60%; font-size: 13px; font-weight: 600; color: #334155; text-align: right;">${vtRequestId}</div>
                  </div>`
                  }
                  <div style="border-top: 1px solid #e2e8f0; padding-top: 32px; margin-top: 16px;">
                    <p style="font-size: 12px; color: #64748b; line-height: 1.5; margin: 0;">If you have any issues with this transaction, please reply directly to this email to reach our support desk.</p>
                  </div>
                </div>
                <div style="background-color: #f8fafc; padding: 30px; text-align: center; border-top: 1px solid #e2e8f0;">
                  <p style="font-size: 11px; color: #64748b; margin: 0 0 8px 0;">Join the AbaPay Community</p>
                  <p style="font-size: 12px; font-weight: 700; margin: 0 0 16px 0;">
                    <a href="https://x.com/abapays" style="color: #334155; text-decoration: none;">X (Twitter)</a> &nbsp;&nbsp; 
                    <a href="https://t.me/abapays" style="color: #334155; text-decoration: none;">Telegram</a> &nbsp;&nbsp; 
                    <a href="https://wa.me/2347075418792" style="color: #334155; text-decoration: none;">WhatsApp</a>
                  </p>
                  <p style="font-size: 10px; color: #94a3b8; margin: 0;">&copy; 2026 Masonode Technologies Limited. All rights reserved.</p>
                </div>
              </div>
            </div>`;

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
            await sendTelegramAlert(`❌ *VENDING REJECTED*\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode}\n🚨 *Admin Error:* Code ${payData.code} - ${payData.response_description}\n🗣 *User Message:* ${friendlyMessage}\n🔍 *Explorer:* ${explorerUrl}`);
        } catch (tgError) {
            console.error("Telegram Failure Alert Error:", tgError);
        }

        return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: friendlyMessage });
    }

  } catch (error: any) {
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: "System error recording transaction." }, { status: 500 });
  }
}
