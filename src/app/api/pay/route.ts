import { NextResponse } from 'next/server';
import { BASE_URL, generateRequestId, getHeaders } from '@/lib/vtpass';
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; 
import { supabase } from '@/utils/supabase'; 

const processedTransactions = new Set();

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { serviceID, billersCode, amount, token: tokenSymbol, txHash, variation_code, phone, nairaAmount } = body;

    // 1. REPLAY ATTACK PREVENTION
    if (processedTransactions.has(txHash)) {
      return NextResponse.json({ success: false, code: "DUPLICATE_HASH", message: "Duplicate hash blocked." }, { status: 400 });
    }

    // 2. PERFECT FLAT MATH (No hidden percentages)
    const requestedNaira = parseFloat(nairaAmount);
    const needsVerification = serviceID.includes('electric') || serviceID.includes('tv');
    const serviceFee = needsVerification ? 100 : 0;
    
    // The EXACT flat amount to send to VTpass (e.g., 100)
    const vendAmount = requestedNaira; 

    // SECURITY: Ensure the user actually paid enough crypto based ONLY on your .env rate
    const baseRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");
    const expectedTotalNaira = vendAmount + serviceFee;
    const requiredCrypto = expectedTotalNaira / baseRate;

    // 1% buffer for floating point rounding differences in Javascript
    if (parseFloat(amount) < (requiredCrypto * 0.99)) {
        await sendTelegramAlert(`⚠️ *INSUFFICIENT FUNDS PAID*\nUser requested ₦${expectedTotalNaira} but only paid ${amount} crypto.\nHash: ${txHash}`);
        return NextResponse.json({ success: false, message: "Insufficient crypto paid for this request." }, { status: 400 });
    }

    // 3. GUARANTEED DATABASE LOGGING
    const { error: dbError } = await supabase.from('transactions').insert([{
      tx_hash: txHash,
      service_category: serviceID,
      account_number: billersCode || phone || "N/A",
      amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount,
      fee_naira: serviceFee,
      status: 'PROCESSING'
    }]);
    
    if (dbError) {
      console.error("SUPABASE ERROR:", dbError.message);
      await sendTelegramAlert(`🚨 *DATABASE CRASH!*\nSupabase refused to save the ledger.\n*Reason:* ${dbError.message}\nHash: ${txHash}`);
    }

    // 4. MERCHANT VERIFICATION
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

    // 5. VTPASS PAYLOAD CONSTRUCTION
    const isAirtime = ['mtn', 'airtel', 'glo', '9mobile'].includes(serviceID);
    const vtpassPayload: any = {
      request_id: generateRequestId(),
      serviceID: serviceID,
      amount: vendAmount,
      phone: phone || billersCode
    };

    if (!isAirtime) {
      vtpassPayload.billersCode = billersCode;
      vtpassPayload.variation_code = variation_code;
    }

    // 6. VTPASS EXECUTION
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

    // 7. FINAL SUCCESS OR FAILURE HANDLING
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
