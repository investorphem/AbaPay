import { NextResponse } from 'next/server';
import { BASE_URL, generateRequestId, getHeaders } from '@/lib/vtpass';
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; 
import { supabase } from '@/utils/supabase'; 

const processedTransactions = new Set();

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { 
        serviceID,      
        billersCode,    
        amount,         
        token: tokenSymbol, 
        txHash,         
        variation_code, 
        phone 
    } = body;

    // 1. REPLAY ATTACK PREVENTION
    if (processedTransactions.has(txHash)) {
      return NextResponse.json({ success: false, code: "DUPLICATE_HASH", message: "Duplicate hash blocked." }, { status: 400 });
    }

    // 2. MATH & FEES
    const baseRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");
    const profitSpread = 1.03; 
    const exchangeRate = baseRate * profitSpread;
    const totalNairaValue = parseFloat(amount) * exchangeRate;
    const needsVerification = serviceID.includes('electric') || serviceID.includes('tv');
    const serviceFee = needsVerification ? 100 : 0;
    const vendAmount = Math.floor(totalNairaValue - serviceFee);

    // 3. GUARANTEED DATABASE LOGGING (Saves immediately before anything can fail)
    const { error: dbError } = await supabase.from('transactions').insert([{
      tx_hash: txHash,
      service_category: serviceID,
      account_number: billersCode,
      amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount,
      fee_naira: serviceFee,
      status: 'PROCESSING'
    }]);
    
    if (dbError) console.error("SUPABASE INITIAL INSERT ERROR:", dbError.message);

    // 4. MINIMUM LIMIT CHECK (Now properly updates the database and returns a code)
    if (totalNairaValue < 500) {
      await supabase.from('transactions').update({ status: 'FAILED_MIN_LIMIT' }).eq('tx_hash', txHash);
      return NextResponse.json({ success: false, code: "MIN_LIMIT", message: "Minimum order value is ₦500." }, { status: 400 });
    }

    // 5. MERCHANT VERIFICATION
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

    // 6. VTPASS PAYLOAD CONSTRUCTION
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

    // 7. VTPASS EXECUTION
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

    // 8. FINAL SUCCESS OR FAILURE HANDLING
    if (payData.code === '000') {
      processedTransactions.add(txHash);
      const vendedToken = payData.purchased_code || payData.token || "Vended Successfully";

      // Update Ledger to Success
      await supabase.from('transactions').update({ status: 'SUCCESS' }).eq('tx_hash', txHash);

      try { await sendAbaPaySms(vtpassPayload.phone, `AbaPay: Purchase Successful! Token/Ref: ${vendedToken}. Amt: ₦${vendAmount}`); } catch (e) {}
      try { await sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n🛒 *Product:* ${serviceID}\n💰 *Naira:* ₦${vendAmount}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USDT'}\n👤 *User:* ${billersCode}\n⛽ *Fee:* ₦${serviceFee}`); } catch (e) {}

      return NextResponse.json({
        success: true,
        message: "Transaction Successful!",
        data: { vendedToken, vendAmount, requestId: payData.requestId }
      });

    } else {
      // Update Ledger to Vending Failure
      await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('tx_hash', txHash);
      try { await sendTelegramAlert(`🚨 *CRITICAL VENDING ERROR*\nHash: \`${txHash}\`\nVTpass Code: ${payData.code}`); } catch (e) {}

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
