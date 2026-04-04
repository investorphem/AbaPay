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
      return NextResponse.json({ success: false, message: "Duplicate hash blocked." }, { status: 400 });
    }

    // 2. DYNAMIC CURRENCY CONVERSION
    const baseRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");
    const profitSpread = 1.03; 
    const exchangeRate = baseRate * profitSpread;
    const totalNairaValue = parseFloat(amount) * exchangeRate;

    // 3. MINIMUM LIMIT CHECK
    if (totalNairaValue < 500) {
      return NextResponse.json({ success: false, message: "Minimum order value is ₦500." }, { status: 400 });
    }

    // 4. MERCHANT VERIFICATION (Only for Electricity & Cable)
    const needsVerification = serviceID.includes('electric') || serviceID.includes('tv');
    if (needsVerification) {
      const verifyRes = await fetch(`${BASE_URL}/merchant-verify`, {
        method: 'POST',
        headers: getHeaders('POST'),
        body: JSON.stringify({
          billersCode,
          serviceID,
          type: variation_code.includes('postpaid') ? 'postpaid' : 'prepaid'
        })
      });

      const verifyData = await verifyRes.json();
      if (verifyData.code !== '000') {
        return NextResponse.json({ success: false, message: "Account verification failed." }, { status: 400 });
      }
    }

    // 5. FEE & VEND CALCULATION
    const serviceFee = needsVerification ? 100 : 0;
    const vendAmount = Math.floor(totalNairaValue - serviceFee);

    // 6. PERFECT VTPASS PAYLOAD CONSTRUCTION
    // VTpass has different payload rules for Airtime vs Utilities
    const isAirtime = ['mtn', 'airtel', 'glo', '9mobile'].includes(serviceID);
    
    const vtpassPayload: any = {
      request_id: generateRequestId(),
      serviceID: serviceID,
      amount: vendAmount,
      phone: phone || billersCode
    };

    // Only add billersCode and variation_code if it is NOT Airtime
    if (!isAirtime) {
      vtpassPayload.billersCode = billersCode;
      vtpassPayload.variation_code = variation_code;
    }

    // 7. VTPASS EXECUTION
    const payRes = await fetch(`${BASE_URL}/pay`, {
      method: 'POST',
      headers: getHeaders('POST'),
      body: JSON.stringify(vtpassPayload)
    });

    const payData = await payRes.json();

    // 8. DATABASE PAYLOAD (Fixed to prevent DB crashes)
    const dbPayload = {
      tx_hash: txHash,
      service_category: serviceID,
      account_number: billersCode,
      amount_usdt: parseFloat(amount), // FIXED: Sends pure number to prevent DB Type crash
      amount_naira: vendAmount,
      fee_naira: serviceFee,
      status: payData.code === '000' ? 'SUCCESS' : 'FAILED_VENDING'
    };

    // Save to Database Immediately
    const { error: dbError } = await supabase.from('transactions').insert([dbPayload]);
    if (dbError) console.error("SUPABASE ERROR:", dbError.message);

    // 9. HANDLING SUCCESS, LOGGING & ALERTS
    if (payData.code === '000') {
      processedTransactions.add(txHash);
      const vendedToken = payData.purchased_code || payData.token || "Vended Successfully";

      // A. DISPATCH SMS
      try {
        await sendAbaPaySms(vtpassPayload.phone, `AbaPay: Purchase Successful! Token/Ref: ${vendedToken}. Amt: ₦${vendAmount}`);
      } catch (smsErr) {
        console.error("SMS Error:", smsErr);
      }

      // B. DISPATCH TELEGRAM ALERT
      await sendTelegramAlert(
        `✅ *SALE SUCCESSFUL*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🛒 *Product:* ${serviceID}\n` +
        `💰 *Naira:* ₦${vendAmount.toLocaleString()}\n` +
        `🪙 *Asset:* ${amount} ${tokenSymbol || 'USDT'}\n` + 
        `👤 *User:* ${billersCode}\n` +
        `⛽ *Fee:* ₦${serviceFee}`
      );

      return NextResponse.json({
        success: true,
        message: "Transaction Successful!",
        data: { vendedToken, vendAmount, requestId: payData.requestId }
      });

    } else {
      // D. HANDLE VENDING FAILURE
      await sendTelegramAlert(`🚨 *CRITICAL VENDING ERROR*\nHash: \`${txHash}\`\nAsset: ${tokenSymbol}\nVTpass Code: ${payData.code}`);

      return NextResponse.json({ 
        success: false, 
        message: "Vending failed. Admin alerted for manual refund.",
        code: payData.code 
      }, { status: 502 });
    }

  } catch (error: any) {
    console.error("Payment Engine Failure:", error.message);
    return NextResponse.json({ success: false, message: "Internal Server Error" }, { status: 500 });
  }
}
