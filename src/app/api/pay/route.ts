import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass'; 
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; 
import { supabaseAdmin as supabase } from '@/utils/supabase'; 

const error_messages: Record<string, string> = {
    "011": "Invalid arguments. Please check your phone/meter number and try again.",
    "012": "This product does not exist or is currently unavailable.",
    "013": "Amount is below the minimum allowed for this specific utility.",
    "014": "Request blocked. Transaction exceeds your daily limit with this provider.",
    "016": "Transaction failed at the provider level. Please verify details and retry.",
    "017": "Amount is above the maximum allowed for this product.",
    "018": "Service is temporarily unavailable at the provider node. Try again shortly.", 
    "019": "Duplicate transaction detected. Please wait 30 seconds before retrying.",
    "021": "Authentication with the utility provider failed. AbaPay admins are investigating.",
    "022": "Authentication with the utility provider failed. AbaPay admins are investigating.",
    "023": "Authentication with the utility provider failed. AbaPay admins are investigating.",
    "024": "Authentication with the utility provider failed. AbaPay admins are investigating.",
    "028": "Service is temporarily unavailable for this specific product.",
    "030": "Provider network is currently down. Please try again.",
    "034": "Service with this provider is currently suspended. Please try again later.",
    "035": "Service is inactive at the moment. Please try again later.",
    "041": "An error occurred with the vending node. AbaPay will re-vend or refund.",
    "089": "The network is currently processing your previous request. Please wait.",
    "400": "The request payload was malformed. This is a technical error.",
    "FAILED_VERIFICATION": "Merchant verification failed. The provided meter/account number is invalid."
};

const processedTransactions = new Set();

function getStrictRequestId() {
  const date = new Date();
  const lagosTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);

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
      nairaAmount, wallet_address, subscription_type = 'change',
      isForeign, operator_id, country_code, product_type_id, email
    } = body;

    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    if (processedTransactions.has(txHash)) {
      return NextResponse.json({ success: false, code: "DUPLICATE_HASH", message: "Duplicate hash blocked." }, { status: 400 });
    }

    const requestedNaira = parseFloat(nairaAmount);

    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));

    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira; 
    const vtRequestId = getStrictRequestId();

    const dbPayload = {
      tx_hash: txHash,
      request_id: vtRequestId,
      service_category: serviceCategory, 
      network: network, 
      account_number: billersCode || phone || "N/A",
      amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount,
      fee_naira: serviceFee,
      status: 'PROCESSING',
      wallet_address: wallet_address || "UNKNOWN"
    };

    const { error: dbError } = await supabase.from('transactions').insert([dbPayload]);

    if (dbError) {
      return NextResponse.json({ success: false, code: "DB_REJECTED", message: `DB Error: ${dbError.message}` }, { status: 400 });
    }

    const { data: settingsData, error: settingsError } = await supabase
      .from('platform_settings')
      .select('exchange_rate')
      .eq('id', 1)
      .single();

    if (settingsError || !settingsData) {
      await supabase.from('transactions').update({ status: 'FAILED_RATE_FETCH' }).eq('tx_hash', txHash);
      return NextResponse.json({ success: false, code: "SYSTEM_ERROR", message: "Failed to fetch platform exchange rate." }, { status: 500 });
    }

    const baseRate = parseFloat(settingsData.exchange_rate);
    const expectedTotalNaira = vendAmount + serviceFee;
    const requiredCrypto = expectedTotalNaira / baseRate;

    // ⚡ FIX: Matches the frontend's 4-decimal rounding perfectly to prevent micro-fraction underpayment flags
    const expectedCryptoStr = requiredCrypto.toFixed(4);
    
    if (parseFloat(amount) < parseFloat(expectedCryptoStr)) {
        await supabase.from('transactions').update({ status: 'FAILED_FUNDS_MISMATCH' }).eq('tx_hash', txHash);
        try { await sendTelegramAlert(`🚨 *RATE MISMATCH / UNDERPAYMENT*\nUser: ${wallet_address}\nHash: \`${txHash}\`\nThey paid: ${amount} ${tokenSymbol}. We expected: ${expectedCryptoStr} based on rate ₦${baseRate}.`); } catch (e) {}
        return NextResponse.json({ success: false, code: "FUNDS", message: "Insufficient crypto paid. Admin has been notified." }, { status: 400 });
    }

    if (needsVerification) {
      const verifyRes = await fetch(`${baseUrl}/merchant-verify`, {
        method: 'POST',
        headers: getHeaders(), 
        body: JSON.stringify({ 
          billersCode, 
          serviceID, 
          type: serviceCategory === 'ELECTRICITY' ? (variation_code.includes('postpaid') ? 'postpaid' : 'prepaid') : (serviceCategory === 'BANK' || serviceCategory === 'EDUCATION') ? variation_code : undefined 
        })
      });

      const verifyData = await verifyRes.json();
      if (verifyData.code !== '000') {
        await supabase.from('transactions').update({ status: 'FAILED_VERIFICATION' }).eq('tx_hash', txHash);
        return NextResponse.json({ success: false, code: "VERIFY_FAIL", message: error_messages.FAILED_VERIFICATION }, { status: 400 });
      }
    }

    let vtpassPayload: any = {
      request_id: vtRequestId,
      serviceID: serviceID, 
      amount: vendAmount,
      phone: phone || billersCode
    };

    if (isForeign) {
      vtpassPayload.billersCode = billersCode;
      vtpassPayload.variation_code = variation_code;
      vtpassPayload.operator_id = operator_id;
      vtpassPayload.country_code = country_code;
      vtpassPayload.product_type_id = product_type_id;
      vtpassPayload.email = email || "support@abapay.com";
    } else {
      if (serviceCategory === 'DATA' || serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK') {
        vtpassPayload.billersCode = billersCode;
        vtpassPayload.variation_code = variation_code;
      }
      else if (serviceCategory === 'EDUCATION') {
        vtpassPayload.variation_code = variation_code;
        if (serviceID === 'jamb') {
           vtpassPayload.billersCode = billersCode; 
        }
      }
      else if (serviceCategory === 'INTERNET') {
        vtpassPayload.billersCode = billersCode;
        vtpassPayload.variation_code = variation_code;
        if (serviceID === 'spectranet') {
           vtpassPayload.quantity = 1;
        }
      }
      else if (serviceCategory === 'CABLE') {
        vtpassPayload.billersCode = billersCode;

        if (serviceID === 'dstv' || serviceID === 'gotv') {
          vtpassPayload.subscription_type = subscription_type;
          if (subscription_type === 'change') {
            vtpassPayload.variation_code = variation_code;
            vtpassPayload.quantity = 1;
          }
        } else {
          vtpassPayload.variation_code = variation_code;
        }
      }
    }

    let payRes, payData;
    try {
      payRes = await fetch(`${baseUrl}/pay`, {
        method: 'POST',
        headers: getHeaders(), 
        body: JSON.stringify(vtpassPayload)
      });
      payData = await payRes.json();
    } catch (e: any) {
      await supabase.from('transactions').update({ status: 'FAILED_VTPASS_CRASH' }).eq('tx_hash', txHash);
      return NextResponse.json({ success: false, code: "VTPASS_CRASH", message: "Network timeout while contacting provider." }, { status: 502 });
    }

    if (payData.code === '000' || payData.code === '099') {
      processedTransactions.add(txHash);

      const actualStatus = payData.content?.transactions?.status || 'pending';

      if (actualStatus === 'delivered' || actualStatus === 'successful') {

        let dbPurchasedCode = null;
        let vendedUnits = null;
        let alertTokenRef = "Success"; 

        if (serviceCategory === 'ELECTRICITY' && !isForeign) {
          dbPurchasedCode = payData.purchased_code || payData.token || null;
          alertTokenRef = dbPurchasedCode || "Processing Token";

          if (payData.units) vendedUnits = payData.units.toString();
          else if (payData.content?.transactions?.units) vendedUnits = payData.content.transactions.units.toString();
          else if (payData.content?.transactions?.unit) vendedUnits = payData.content.transactions.unit.toString();
        } else if (serviceCategory === 'EDUCATION') {
          dbPurchasedCode = payData.purchased_code || payData.Pin || null;
          alertTokenRef = dbPurchasedCode || "Processing PIN";
        } else {
          alertTokenRef = payData.content?.transactions?.transactionId || payData.requestId || "Success";
        }

        await supabase.from('transactions').update({ 
            status: 'SUCCESS',
            purchased_code: dbPurchasedCode, 
            units: vendedUnits 
        }).eq('tx_hash', txHash);

        try { await sendAbaPaySms(vtpassPayload.phone, `Purchase Successful! Ref: ${alertTokenRef}. Amt: ₦${vendAmount}`); } catch (e) {}
        try { await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Naira:* ₦${vendAmount}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode || phone}\n⛽ *Fee:* ₦${serviceFee}\n🧾 *Ref:* ${alertTokenRef}`); } catch (e) {}

        return NextResponse.json({
          success: true,
          message: "Transaction Successful!",
          purchased_code: dbPurchasedCode, 
          units: vendedUnits, 
          data: { vendedToken: alertTokenRef, vendAmount, requestId: payData.requestId, units: vendedUnits }
        });

      } else if (actualStatus === 'pending' || actualStatus === 'initiated' || payData.code === '099') {
        await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash);
        try { await sendTelegramAlert(`⏳ *TRANSACTION PENDING*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n⚠️ Network delayed. Awaiting final delivery confirmation from VTpass.`); } catch (e) {}

        return NextResponse.json({
          success: true, 
          message: "Transaction is processing. Your utility will be delivered shortly.",
          data: { vendedToken: "Processing...", vendAmount, requestId: payData.requestId }
        });
      } else {
        await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('tx_hash', txHash);
        try { await sendTelegramAlert(`🚨 *VENDING FAILED (Inner Status)*\nHash: \`${txHash}\`\nStatus: ${actualStatus}`); } catch (e) {}

        return NextResponse.json({ success: false, message: "Transaction failed at the provider network level.", code: "INNER_FAIL" }, { status: 502 });
      }

    } else {
      await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('tx_hash', txHash);
      const rawAdminError = payData.response_description || 'Unknown Provider Error';
      try { await sendTelegramAlert(`🚨 *VENDING REJECTED*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n❌ *VTpass Code:* ${payData.code}\n🛑 *Real Error:* ${rawAdminError}\n🔗 *Hash:* \`${txHash}\``); } catch (e) {}

      const friendlyMessage = error_messages[payData.code as string] || "Utility vending failed at the provider level. Please contact support.";
      return NextResponse.json({ success: false, message: friendlyMessage, code: payData.code }, { status: 502 });
    }

  } catch (error: any) {
    console.error("Payment Engine Failure:", error.message);
    return NextResponse.json({ success: false, code: "SYSTEM_CRASH", message: "Internal Server Error" }, { status: 500 });
  }
}
