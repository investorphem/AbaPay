import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase'; 
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass'; 
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

const error_messages: Record<string, string> = {
    "011": "Invalid details. Check your phone/meter number.",
    "014": "Daily limit exceeded with this provider.",
    "016": "Provider network is unstable. Please try again.",
    "018": "Service temporarily unavailable.", 
    "030": "Provider network is down.",
    "400": "Transaction failed due to a system error."
};

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
      nairaAmount, wallet_address, subscription_type,
      operator_id, country_code, product_type_id, email,
      meter_account_type, blockchain,
      intent_only // ⚡ THE CRITICAL FLAG FOR INSTANT UI + SAFETY NET ⚡
    } = body;

    const requestedNaira = parseFloat(nairaAmount);
    const isForeign = serviceID === 'foreign-airtime';
    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira; 
    const vtRequestId = getStrictRequestId();

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
      operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null, subscription_type: subscription_type || null 
    };

    // If the frontend is just saving the intent (before blockchain wait), save as PENDING and exit instantly
    if (intent_only) {
        await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });
        return NextResponse.json({ success: true, status: "PENDING" });
    }

    // If it's the real vend execution, securely lock the row to PROCESSING
    const { data: lockedRecord, error: lockError } = await supabase
      .from('transactions')
      .update({ status: 'PROCESSING', request_id: vtRequestId })
      .eq('tx_hash', txHash)
      .eq('status', 'PENDING') // Only lock it if the webhook hasn't touched it yet!
      .select()
      .single();

    if (!lockedRecord || lockError) {
        // The Webhook got here first and is already vending it! Let the frontend know to check history.
        return NextResponse.json({ success: true, status: "TIMEOUT", message: "Vending handled by background webhook." });
    }

    // 3. CONSTRUCT VTPASS PAYLOAD
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    let vtpassPayload: any = { request_id: vtRequestId, serviceID: serviceID, amount: vendAmount, phone: phone || billersCode };

    if (isForeign) {
        vtpassPayload.billersCode = billersCode; vtpassPayload.variation_code = variation_code; vtpassPayload.operator_id = operator_id; vtpassPayload.country_code = country_code; vtpassPayload.product_type_id = product_type_id; vtpassPayload.email = email || "support@abapay.com";
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

    // 4. CALL VTPASS DIRECTLY
    let payRes, payData;
    try {
        payRes = await fetch(`${baseUrl}/pay`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(vtpassPayload) });
        payData = await payRes.json();
    } catch (e: any) {
        // Revert to pending so the 15-second delay Alchemy Webhook can retry it
        await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash); 
        return NextResponse.json({ success: true, status: "TIMEOUT", message: "Network slow. Finishing in background." }); 
    }

    // 5. HANDLE VTPASS RESPONSE & RETURN INSTANTLY TO FRONTEND
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
        
        // Fire notifications asynchronously so we don't slow down the UI
        sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Naira:* ₦${vendAmount}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode}\n🧾 *Ref:* ${alertTokenRef}`).catch(()=>{});
        
        if (serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION') {
            const typeLabel = serviceCategory === 'ELECTRICITY' ? 'Token' : 'PIN';
            sendAbaPaySms(phone || billersCode, `AbaPay: Your ${network || serviceCategory} ${typeLabel} is ${alertTokenRef}. Amount: N${vendAmount}. Thank you.`).catch(()=>{});
        }
        
        if (email) {
            resend.emails.send({
                from: 'AbaPay Receipts <receipts@abapays.com>', to: email, replyTo: 'support@abapays.com', subject: `AbaPay Receipt - ${network} ${serviceCategory}`,
                html: `<div style="font-family: sans-serif; background-color: #f4f4f5; padding: 40px 0;"><div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden;"><div style="background: #18181b; padding: 40px 30px; text-align: center;"><h1 style="color:white">AbaPay</h1></div><div style="padding: 40px 30px;"><h2 style="color: #18181b; font-size: 32px;">₦${vendAmount.toLocaleString()}</h2><p>Account: ${billersCode}</p><p>Tx Hash: ${txHash}</p>${dbPurchasedCode ? `<p style="color:#10b981; font-weight:bold;">Token / PIN: ${dbPurchasedCode}</p>` : ``}</div></div></div>`
            }).catch(()=>{});
        }

        const points = Number((vendAmount / 1000).toFixed(2));
        if (points > 0 && wallet_address) supabase.rpc('award_transaction_points', { target_wallet: wallet_address.toLowerCase(), points_to_add: points }).catch(()=>{});

        // ⚡ INSTANT SUCCESS TO FRONTEND ⚡
        return NextResponse.json({ success: true, status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits, request_id: vtRequestId });
    } else {
        const friendlyMessage = error_messages[payData.code as string] || "Service is temporarily undergoing maintenance.";
        await supabase.from('transactions').update({ status: 'VENDING_FAILED', error_code: payData.code, api_response: payData.response_description }).eq('tx_hash', txHash);
        sendTelegramAlert(`❌ *VENDING REJECTED*\n⛓️ *Chain:* ${blockchain || 'CELO'}\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode}\n🚨 *Admin Error:* Code ${payData.code} - ${payData.response_description}\n🗣 *User Message:* ${friendlyMessage}`).catch(()=>{});
        
        return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: friendlyMessage });
    }

  } catch (error: any) {
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: "System error recording transaction." }, { status: 500 });
  }
}
