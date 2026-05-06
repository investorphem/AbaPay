import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase'; 
import { sendTelegramAlert } from '@/lib/telegram';

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
      operator_id, country_code, product_type_id, email,
      meter_account_type, blockchain 
    } = body;

    const requestedNaira = parseFloat(nairaAmount);
    const isForeign = serviceID === 'foreign-airtime';
    
    // Determine Verification Needs for Fee Calculation
    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira; 
    const vtRequestId = getStrictRequestId();

    // ⚡ STEP 1: VERIFY AMOUNT vs EXCHANGE RATE FIRST ⚡
    const { data: settingsData, error: settingsError } = await supabase
      .from('platform_settings')
      .select('exchange_rate')
      .eq('id', 1)
      .single();

    if (settingsError || !settingsData) {
      return NextResponse.json({ success: false, code: "SYSTEM_ERROR", message: "Failed to fetch platform exchange rate." }, { status: 500 });
    }

    const baseRate = parseFloat(settingsData.exchange_rate);
    const expectedTotalNaira = vendAmount + serviceFee;
    const requiredCrypto = expectedTotalNaira / baseRate;
    const expectedCryptoStr = requiredCrypto.toFixed(4);

    if (parseFloat(amount) < parseFloat(expectedCryptoStr)) {
        try { await sendTelegramAlert(`🚨 *RATE MISMATCH PREVENTED*\n⛓️ *Chain:* ${blockchain || 'CELO'}\nUser: ${wallet_address}\nHash: \`${txHash}\`\nAttempted to pay: ${amount} ${tokenSymbol}. Expected: ${expectedCryptoStr} based on rate ₦${baseRate}.`); } catch (e) {}
        return NextResponse.json({ success: false, code: "FUNDS", message: "Insufficient crypto paid. Request rejected." }, { status: 400 });
    }

    // ⚡ STEP 2: SAVE INTENT TO DATABASE (WEBHOOK TAKES OVER FROM HERE) ⚡
    const dbPayload = {
      tx_hash: txHash,
      request_id: vtRequestId,
      service_category: serviceCategory, 
      service_id: serviceID,             // Webhook needs this
      variation_code: variation_code,    // Webhook needs this
      network: network, 
      blockchain: blockchain || "CELO",
      account_number: billersCode || phone || "N/A",
      phone: phone || null,              // Webhook needs this for SMS
      amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount,
      fee_naira: serviceFee,
      status: 'PENDING',                 // MUST BE PENDING FOR WEBHOOK TO CATCH IT
      wallet_address: wallet_address || "UNKNOWN",
      token_used: tokenSymbol,
      meter_account_type: meter_account_type || null,
      customer_email: email || null,
      operator_id: operator_id || null,  // For international
      country_code: country_code || null, // For international
      product_type_id: product_type_id || null, // For international
      subscription_type: subscription_type || null // For Cable
    };

    const { error: dbError } = await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });

    if (dbError) {
      return NextResponse.json({ success: false, code: "DB_REJECTED", message: `Database Error: Could not save transaction intent.` }, { status: 400 });
    }

    // ⚡ STEP 3: RESPOND IMMEDIATELY ⚡
    // We do not call VTPass here. The Webhook will handle it when the block is confirmed.
    return NextResponse.json({ 
        success: true, 
        message: "Transaction Intent Recorded. Vending will begin upon network confirmation.",
        status: "PENDING"
    }, { status: 200 });

  } catch (error: any) {
    return NextResponse.json({ success: false, code: "SYSTEM_CRASH", message: "System error recording transaction." }, { status: 500 });
  }
}
