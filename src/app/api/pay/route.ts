import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; 
import { supabase } from '@/utils/supabase'; 

const processedTransactions = new Set();

function getStrictRequestId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${year}${month}${day}${hours}${minutes}${random}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { serviceID, billersCode, amount, token: tokenSymbol, txHash, variation_code, phone, nairaAmount } = body;

    if (processedTransactions.has(txHash)) {
      return NextResponse.json({ success: false, code: "DUPLICATE_HASH", message: "Duplicate hash blocked." }, { status: 400 });
    }

    const requestedNaira = parseFloat(nairaAmount);
    const needsVerification = serviceID.includes('electric') || serviceID.includes('tv');
    const serviceFee = needsVerification ? 100 : 0;
    const vendAmount = requestedNaira; 

    const baseRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");
    const expectedTotalNaira = vendAmount + serviceFee;
    const requiredCrypto = expectedTotalNaira / baseRate;

    if (parseFloat(amount) < (requiredCrypto * 0.99)) {
        return NextResponse.json({ success: false, code: "FUNDS", message: "Insufficient crypto paid." }, { status: 400 });
    }

    // 1. GUARANTEED DATABASE LOGGING (WITH HARD STOP)
    const dbPayload = {
      tx_hash: txHash,
      service_category: serviceID,
      account_number: billersCode || phone || "N/A",
      amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount,
      fee_naira: serviceFee,
      status: 'PROCESSING'
    };

    const { data: dbData, error: dbError } = await supabase.from('transactions').insert([dbPayload]).select();
    
    // IF THE DATABASE FAILS, WE STOP EVERYTHING AND PRINT THE ERROR TO THE SCREEN.
    if (dbError) {
      console.error("SUPABASE ERROR:", dbError.message);
      return NextResponse.json({ 
        success: false, 
        code: "DB_REJECTED", 
        message: `DB Error: ${dbError.message}` 
      }, { status: 400 });
    }

    if (needsVerification) {
      const verifyRes = await fetch(`${BASE_URL}/merchant-verify`, {
        method: 'POST',
        headers: getHeaders('POST'),
        body: JSON.stringify({ billersCode, serviceID, type: variation_code.includes('postpaid') ? 'postpaid' : 'prepaid' })
      });

      const verifyData = await verifyRes.json();
      if (verifyData.code !== '000') {
        await supabase.from('transactions').update({ status: 'FAILED_VERIFICATION' }).eq('tx_hash', txHash);
        return NextResponse.json({ success: false, code: "VERIFY_FAIL", message: "Account verification failed." }, { status: 400 });
      }
    }

    const isAirtime = ['mtn', 'airtel', 'glo', '9mobile'].includes(serviceID);
    const vtpassPayload: any = {
      request_id: getStrictRequestId(),
      serviceID: serviceID,
      amount: vendAmount,
      phone: phone || billersCode
    };

    if (!isAirtime) {
      vtpassPayload.billersCode = billersCode;
      vtpassPayload.variation_code = variation_code;
    }

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

    if (payData.code === '000') {
      processedTransactions.add(txHash);
      const vendedToken = payData.purchased_code || payData.token || "Vended Successfully";

      await supabase.from('transactions').update({ status: 'SUCCESS' }).eq('tx_hash', txHash);

      try { await sendAbaPaySms(vtpassPayload.phone, `AbaPay: Purchase Successful! Token/Ref: ${vendedToken}. Amt: ₦${vendAmount}`); } catch (e) {}
      try { await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n🛒 *Product:* ${serviceID}\n💰 *Naira:* ₦${vendAmount}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USDT'}\n👤 *User:* ${billersCode}\n⛽ *Fee:* ₦${serviceFee}\n🧾 *Ref:* ${vendedToken}`); } catch (e) {}

      return NextResponse.json({
        success: true,
        message: "Transaction Successful!",
        data: { vendedToken, vendAmount, requestId: payData.requestId }
      });

    } else {
      await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('tx_hash', txHash);
      try { await sendTelegramAlert(`🚨 *VENDING REJECTED*\nHash: \`${txHash}\`\nVTpass Code: ${payData.code}`); } catch (e) {}

      return NextResponse.json({ 
        success: false, 
        message: `Vending failed. VTpass Code: ${payData.code}`,
        code: payData.code 
      }, { status: 502 });
    }

  } catch (error: any) {
    console.error("Payment Engine Failure:", error.message);
    return NextResponse.json({ success: false, code: "SYSTEM_CRASH", message: "Internal Server Error" }, { status: 500 });
  }
}
