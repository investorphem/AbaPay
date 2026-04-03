import { NextResponse } from 'next/server';
import { BASE_URL, generateRequestId, getHeaders } from '@/lib/vtpass';
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; // Import your telegram utility
import { supabase } from '@/utils/supabase'; // Import your supabase client

// SECURITY: Replay Attack Prevention
const processedTransactions = new Set();

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { 
        serviceID,      
        billersCode,    
        amount,         // USDT amount from frontend
        txHash,         
        variation_code, 
        phone,
        email           // Optional email for records
    } = body;

    // 1. REPLAY ATTACK PREVENTION
    if (processedTransactions.has(txHash)) {
      return NextResponse.json({ success: false, message: "Duplicate hash blocked." }, { status: 400 });
    }

    // 2. DYNAMIC CURRENCY CONVERSION
    // Uses your .env.local rate (e.g., 1550) + your 3% spread
    const baseRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");
    const profitSpread = 1.03; 
    const exchangeRate = baseRate * profitSpread;
    const totalNairaValue = parseFloat(amount) * exchangeRate;

    // 3. MINIMUM LIMIT CHECK
    if (totalNairaValue < 500) {
      return NextResponse.json({ success: false, message: "Minimum order value is ₦500." }, { status: 400 });
    }

    // 4. MERCHANT VERIFICATION (Documentation Rule)
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
      return NextResponse.json({ success: false, message: "Account verification failed. Check details." }, { status: 400 });
    }

    // 5. FEE & VEND CALCULATION
    const serviceFee = (serviceID.includes('electric') || serviceID.includes('tv')) ? 100 : 0;
    const vendAmount = Math.floor(totalNairaValue - serviceFee);

    // 6. VTPASS EXECUTION
    const payRes = await fetch(`${BASE_URL}/pay`, {
      method: 'POST',
      headers: getHeaders('POST'),
      body: JSON.stringify({
        request_id: generateRequestId(),
        serviceID,
        billersCode,
        variation_code,
        amount: vendAmount,
        phone: phone || billersCode
      })
    });

    const payData = await payRes.json();

    // 7. HANDLING SUCCESS, LOGGING & ALERTS
    if (payData.code === '000') {
      processedTransactions.add(txHash);
      const token = payData.purchased_code || payData.token || "Vended Successfully";

      // A. DISPATCH SMS (DND Fallback V2)
      await sendAbaPaySms(phone, `AbaPay: Purchase Successful! Token/Ref: ${token}. Amt: ₦${vendAmount}`);

      // B. DISPATCH TELEGRAM ALERT (For Admin)
      await sendTelegramAlert(
        `✅ *SALE SUCCESSFUL*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🛒 *Product:* ${serviceID}\n` +
        `💰 *Naira:* ₦${vendAmount}\n` +
        `💵 *USDT:* ${amount}\n` +
        `👤 *User:* ${billersCode}\n` +
        `⛽ *Fee:* ₦${serviceFee}`
      );

      // C. CLOUD LEDGER SYNC (Supabase)
      await supabase.from('transactions').insert([{
        tx_hash: txHash,
        service_category: serviceID,
        account_number: billersCode,
        amount_usdt: amount,
        amount_naira: vendAmount,
        fee_naira: serviceFee,
        status: 'SUCCESS'
      }]);

      return NextResponse.json({
        success: true,
        message: "Transaction Successful!",
        data: { token, vendAmount, requestId: payData.requestId }
      });

    } else {
      // D. HANDLE VENDING FAILURE (Alert Admin immediately)
      await sendTelegramAlert(`🚨 *CRITICAL VENDING ERROR*\nHash: \`${txHash}\`\nVTpass Code: ${payData.code}`);
      
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