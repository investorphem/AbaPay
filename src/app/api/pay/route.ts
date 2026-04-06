import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; 
import { supabaseAdmin as supabase } from '@/utils/supabase'; 

// --- ROBUST ERROR CODE DICTIONARY ---
// Translates raw VTpass codes into friendly, actionable user instructions.
const error_messages = {
    "013": "Amount is below the minimum allowed for your specific meter/band.",
    "014": "Transaction exceeds your daily limit with this utility provider.",
    "015": "Service with this provider is currently suspended. Please try again later.",
    "016": "Incorrect meter/account number. Please verify and re-type.",
    "018": "Service is temporarily unavailable at the provider node. Try again shortly.",
    "019": "Authentication with the utility provider failed. AbaPay admins are investigating.",
    "028": "Insufficient funds in AbaPay's central vault. Retrying automated top-up.",
    "041": "An error occurred with the vending node. AbaPay will re-vend or refund.",
    "400": "The request payload was malformed. This is a technical error.",
    "FAILED_VERIFICATION": "Merchant verification failed. The provided meter number is invalid."
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
      nairaAmount, wallet_address, subscription_type = 'change' 
    } = body;

    if (processedTransactions.has(txHash)) {
      return NextResponse.json({ success: false, code: "DUPLICATE_HASH", message: "Duplicate hash blocked." }, { status: 400 });
    }

    const requestedNaira = parseFloat(nairaAmount);
    const needsVerification = serviceCategory === 'ELECTRICITY' || (serviceCategory === 'CABLE' && network !== 'SHOWMAX');
    const serviceFee = needsVerification ? 100 : 0;
    const vendAmount = requestedNaira; 

    const baseRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");
    const expectedTotalNaira = vendAmount + serviceFee;
    const requiredCrypto = expectedTotalNaira / baseRate;

    if (parseFloat(amount) < (requiredCrypto * 0.99)) {
        return NextResponse.json({ success: false, code: "FUNDS", message: "Insufficient crypto paid." }, { status: 400 });
    }

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

    const { data: dbData, error: dbError } = await supabase.from('transactions').insert([dbPayload]).select();

    if (dbError) {
      console.error("SUPABASE ERROR:", dbError.message);
      return NextResponse.json({ success: false, code: "DB_REJECTED", message: `DB Error: ${dbError.message}` }, { status: 400 });
    }

    // 2. MERCHANT VERIFICATION
    if (needsVerification) {
      const verifyRes = await fetch(`${BASE_URL}/merchant-verify`, {
        method: 'POST',
        headers: getHeaders('POST'),
        body: JSON.stringify({ 
          billersCode, 
          serviceID, 
          type: serviceCategory === 'ELECTRICITY' ? (variation_code.includes('postpaid') ? 'postpaid' : 'prepaid') : undefined 
        })
      });

      const verifyData = await verifyRes.json();
      if (verifyData.code !== '000') {
        await supabase.from('transactions').update({ status: 'FAILED_VERIFICATION' }).eq('tx_hash', txHash);
        // UPGRADED: Return descriptive error for verification
        return NextResponse.json({ success: false, code: "VERIFY_FAIL", message: error_messages.FAILED_VERIFICATION }, { status: 400 });
      }
    }

    // 3. BUILD THE VTPASS PAYLOAD
    const vtpassPayload: any = {
      request_id: vtRequestId,
      serviceID: serviceID, 
      amount: vendAmount,
      phone: phone || billersCode
    };

    if (serviceCategory === 'DATA' || serviceCategory === 'ELECTRICITY') {
      vtpassPayload.billersCode = billersCode;
      vtpassPayload.variation_code = variation_code;
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

    // 4. FIRE THE VENDING REQUEST
    let payRes, payData;
    try {
      payRes = await fetch(`${BASE_URL}/pay`, {
        method: 'POST',
        headers: getHeaders('POST'),
        body: JSON.stringify(vtpassPayload)
      });
      payData = await payRes.json();
    } catch (e: any) {
      await supabase.from('transactions').update({ status: 'FAILED_VTPASS_CRASH' }).eq('tx_hash', txHash);
      return NextResponse.json({ success: false, code: "VTPASS_CRASH", message: e.message }, { status: 502 });
    }

    // 5. HANDLE VTPASS RESPONSE
    if (payData.code === '000') {
      processedTransactions.add(txHash);
      const vendedToken = payData.purchased_code || payData.token || "Vended Successfully";

      await supabase.from('transactions').update({ status: 'SUCCESS' }).eq('tx_hash', txHash);

      try { await sendAbaPaySms(vtpassPayload.phone, `Purchase Successful! Token/Ref: ${vendedToken}. Amt: ₦${vendAmount}`); } catch (e) {}
      try { await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Naira:* ₦${vendAmount}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode}\n⛽ *Fee:* ₦${serviceFee}\n🧾 *Ref:* ${vendedToken}`); } catch (e) {}

      return NextResponse.json({
        success: true,
        message: "Transaction Successful!",
        data: { vendedToken, vendAmount, requestId: payData.requestId }
      });

    } else {
      await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('tx_hash', txHash);
      try { await sendTelegramAlert(`🚨 *VENDING REJECTED*\nHash: \`${txHash}\`\nVTpass Code: ${payData.code}`); } catch (e) {}

      // UPGRADED: Send a friendly error message from our dictionary
      const friendlyMessage = error_messages[payData.code] || "Utility vending failed at the provider level.";
      
      return NextResponse.json({ 
        success: false, 
        message: friendlyMessage,
        code: payData.code 
      }, { status: 502 });
    }

  } catch (error: any) {
    console.error("Payment Engine Failure:", error.message);
    return NextResponse.json({ success: false, code: "SYSTEM_CRASH", message: "Internal Server Error" }, { status: 500 });
  }
}
