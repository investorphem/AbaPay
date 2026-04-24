import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass'; 
import { sendAbaPaySms } from '@/lib/messaging';
import { sendTelegramAlert } from '@/lib/telegram'; 
import { supabaseAdmin as supabase } from '@/utils/supabase'; 
import { Resend } from 'resend'; 

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

const error_messages: Record<string, string> = {
    "011": "Invalid details provided. Please check your phone/meter number and try again.",
    "012": "This product is currently unavailable.",
    "013": "Amount is below the minimum allowed.",
    "014": "Transaction exceeds your daily limit with this provider.",
    "016": "The provider network is currently unstable. Please try again.",
    "017": "Amount is above the maximum allowed for this product.",
    "018": "Service is temporarily unavailable. Try again shortly.", 
    "019": "Duplicate transaction detected. Please wait 30 seconds before retrying.",
    "021": "Service is temporarily undergoing maintenance. Please try again later.",
    "022": "Service is temporarily undergoing maintenance. Please try again later.",
    "023": "Service is temporarily undergoing maintenance. Please try again later.",
    "024": "Service is temporarily undergoing maintenance. Please try again later.",
    "027": "Service is temporarily undergoing maintenance. Please try again later.", 
    "028": "This specific product is temporarily unavailable. Please try another service.", 
    "030": "Provider network is currently down. Please try again.",
    "034": "Service is currently suspended by the provider. Please try again later.",
    "035": "Service is inactive at the moment. Please try again later.",
    "041": "A network error occurred. Please contact support if your funds were deducted.",
    "089": "The network is processing your previous request. Please wait.",
    "400": "Transaction failed due to a system error. Please try again.",
    "FAILED_VERIFICATION": "Verification failed. The provided meter or account number is invalid."
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
      operator_id, country_code, product_type_id, email,
      meter_account_type
    } = body;

    const isForeign = serviceID === 'foreign-airtime';

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
      wallet_address: wallet_address || "UNKNOWN",
      token_used: tokenSymbol,
      meter_account_type: meter_account_type || null,
      customer_email: email || null 
    };

    const { error: dbError } = await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });

    if (dbError) {
      return NextResponse.json({ success: false, code: "DB_REJECTED", message: `DB Error: ${dbError.message}` }, { status: 400 });
    }

    const { data: settingsData, error: settingsError } = await supabase
      .from('platform_settings')
      .select('exchange_rate')
      .eq('id', 1)
      .single();

    if (settingsError || !settingsData) {
      await supabase.from('transactions').update({ 
          status: 'FAILED_RATE_FETCH', 
          error_code: 'SYS_RATE', 
          api_response: 'Failed to fetch platform exchange rate.' 
      }).eq('tx_hash', txHash);
      return NextResponse.json({ success: false, code: "SYSTEM_ERROR", message: "Failed to fetch platform exchange rate." }, { status: 500 });
    }

    const baseRate = parseFloat(settingsData.exchange_rate);
    const expectedTotalNaira = vendAmount + serviceFee;
    const requiredCrypto = expectedTotalNaira / baseRate;
    const expectedCryptoStr = requiredCrypto.toFixed(4);

    if (parseFloat(amount) < parseFloat(expectedCryptoStr)) {
        await supabase.from('transactions').update({ 
            status: 'FAILED_FUNDS_MISMATCH',
            error_code: 'FUNDS_MISMATCH',
            api_response: `Paid ${amount}, Expected ${expectedCryptoStr}`
        }).eq('tx_hash', txHash);
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
        await supabase.from('transactions').update({ 
            status: 'FAILED_VERIFICATION',
            error_code: verifyData.code,
            api_response: verifyData.content?.error || "Merchant verification failed"
        }).eq('tx_hash', txHash);
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
      await supabase.from('transactions').update({ 
          status: 'FAILED_VTPASS_CRASH',
          error_code: '502_TIMEOUT',
          api_response: e.message || 'Fetch failed entirely'
      }).eq('tx_hash', txHash);
      try { await sendTelegramAlert(`❌ *NETWORK CRASH (LIVE)*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n⚠️ Connection to VTpass timed out completely.`); } catch (err) {}
      return NextResponse.json({ success: false, code: "VTPASS_CRASH", message: "Network timeout while contacting provider. Please try again." }, { status: 200 }); 
    }

    if (!payData.content || !payData.content.transactions) {
        const friendlyMessage = error_messages[payData.code as string] || "Service is temporarily undergoing maintenance. Please try again later.";
        const rawTechnicalError = payData.response_description || payData.content?.errors || "Unknown VTpass Rejection";

        await supabase.from('transactions').update({ 
            status: 'FAILED_VENDING',
            error_code: payData.code,
            api_response: rawTechnicalError
        }).eq('tx_hash', txHash);

        try { await sendTelegramAlert(`❌ *VTPASS REJECTION*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n🚨 *Admin Error:* Code ${payData.code} - ${rawTechnicalError}\n🗣 *User Saw:* ${friendlyMessage}`); } catch (err) {}

        return NextResponse.json({ success: false, message: friendlyMessage, code: payData.code }, { status: 200 }); 
    }

    if (payData.code === '000' || payData.code === '099') {
      processedTransactions.add(txHash);

      const actualStatus = payData.content?.transactions?.status || 'pending';

      if (actualStatus === 'delivered' || actualStatus === 'successful') {

        let dbPurchasedCode = null;
        let vendedUnits = null;
        let alertTokenRef = "Success"; 

        if (serviceCategory === 'ELECTRICITY' && !isForeign) {
          dbPurchasedCode = payData.purchased_code || payData.token || payData.tokens || payData.content?.transactions?.token || payData.content?.transactions?.purchased_code || null;

          if (!dbPurchasedCode) {
              const rawPayloadString = JSON.stringify(payData);
              const tokenMatch = rawPayloadString.match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i);
              if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, '');
          }

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

        const requiresCode = (serviceCategory === 'ELECTRICITY' && !isForeign) || serviceCategory === 'EDUCATION';

        if (requiresCode && !dbPurchasedCode) {
            await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash);

            try { await sendTelegramAlert(`⏳ *TOKEN DELAYED (PENDING)*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n⚠️ Provider reported success but no PIN/Token was generated yet. Moved to PENDING for requery.`); } catch (e) {}

            return NextResponse.json({
              success: true,
              message: "Transaction is processing. Awaiting Token/PIN generation from the provider.",
              data: { vendedToken: "Processing...", vendAmount, requestId: payData.requestId, units: vendedUnits }
            });
        }

        await supabase.from('transactions').update({ 
            status: 'SUCCESS',
            purchased_code: dbPurchasedCode, 
            units: vendedUnits 
        }).eq('tx_hash', txHash);

        const notifications = [];

        notifications.push(
          sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n🛒 *Product:* ${network} ${serviceCategory}\n💰 *Naira:* ₦${vendAmount}\n🪙 *Asset:* ${amount} ${tokenSymbol || 'USD₮'}\n👤 *User:* ${billersCode || phone}\n⛽ *Fee:* ₦${serviceFee}\n🧾 *Ref:* ${alertTokenRef}`)
        );

        if (serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION') {
          const typeLabel = serviceCategory === 'ELECTRICITY' ? 'Token' : 'PIN';
          const networkDisplay = network || serviceCategory; 

          notifications.push(
            sendAbaPaySms(phone || billersCode, `AbaPay: Your ${networkDisplay} ${typeLabel} is ${alertTokenRef}. Amount: N${vendAmount}. Thank you.`)
          );
        }

        if (email) {
                              const emailPromise = resend.emails.send({
            from: 'AbaPay Receipts <receipts@abapays.com>',
            to: email,
            replyTo: 'support@abapays.com', // <--- Change to capital T
            subject: `AbaPay Receipt - ${network} ${serviceCategory}`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; padding: 40px 0; margin: 0;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
                  
                  <div style="background-color: #000000; padding: 30px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">AbaPay</h1>
                  </div>

                  <div style="padding: 40px 30px;">
                    <p style="margin: 0 0 10px; color: #52525b; font-size: 14px; text-transform: uppercase; font-weight: 600;">Transaction Successful</p>
                    <h2 style="margin: 0 0 30px; color: #18181b; font-size: 32px;">₦${vendAmount.toLocaleString()}</h2>
                    
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                      <tr>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Service</td>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500;">${network} ${serviceCategory}</td>
                      </tr>
                      <tr>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Account / Phone</td>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500;">${billersCode || phone}</td>
                      </tr>
                      <tr>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Crypto Charged</td>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500;">${amount} ${tokenSymbol}</td>
                      </tr>
                      <tr>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Transaction Hash</td>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500; word-break: break-all;">${txHash}</td>
                      </tr>
                      ${dbPurchasedCode ? `
                      <tr>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Token / PIN</td>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #10b981; font-size: 18px; text-align: right; font-weight: bold; letter-spacing: 2px;">
                          ${dbPurchasedCode}
                        </td>
                      </tr>
                      ` : `
                      <tr>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a; font-size: 15px;">Reference ID</td>
                        <td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; font-size: 15px; text-align: right; font-weight: 500;">${alertTokenRef}</td>
                      </tr>
                      `}
                    </table>

                    <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 0;">
                      If you have any issues with this transaction, please reply directly to this email to reach our support desk.
                    </p>
                  </div>

                  <div style="background-color: #f4f4f5; padding: 30px; text-align: center; border-top: 1px solid #e4e4e7;">
                    <p style="color: #71717a; font-size: 14px; margin: 0 0 15px;">Join the AbaPay Community</p>
                    
                    <div>
                      <a href="https://twitter.com/abapays" style="display: inline-block; margin: 0 10px; color: #000000; text-decoration: none; font-weight: 600; font-size: 14px;">X (Twitter)</a>
                      <a href="https://t.me/abapays" style="display: inline-block; margin: 0 10px; color: #000000; text-decoration: none; font-weight: 600; font-size: 14px;">Telegram</a>
                      <a href="https://wa.me/YourWhatsAppNumber" style="display: inline-block; margin: 0 10px; color: #000000; text-decoration: none; font-weight: 600; font-size: 14px;">WhatsApp</a>
                    </div>
                    
                    <p style="color: #a1a1aa; font-size: 12px; margin: 20px 0 0;">
                      &copy; 2026 Masonode Technologies Limited. All rights reserved.
                    </p>
                  </div>

                </div>
              </div>
            `
          });
          notifications.push(emailPromise);
        }

        const earnedPoints = Number((vendAmount / 1000).toFixed(2));

        if (earnedPoints > 0 && wallet_address) {
            const pointsPromise = supabase.rpc('award_transaction_points', { 
                target_wallet: wallet_address.toLowerCase(), 
                points_to_add: earnedPoints 
            }).then(({ error }) => {
                if (error) console.error("Error distributing points:", error);
            });
            notifications.push(pointsPromise);
        }

        await Promise.allSettled(notifications).catch(err => console.error("Notification Error:", err));

        return NextResponse.json({
          success: true,
          message: "Transaction Successful!",
          purchased_code: dbPurchasedCode, 
          units: vendedUnits, 
          earnedPoints: earnedPoints, 
          data: { vendedToken: alertTokenRef, vendAmount, requestId: payData.requestId, units: vendedUnits }
        });

      } else if (actualStatus === 'pending' || actualStatus === 'initiated' || payData.code === '099') {
        await supabase.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash);
        return NextResponse.json({
          success: true, 
          message: "Transaction is processing. Your utility will be delivered shortly.",
          data: { vendedToken: "Processing...", vendAmount, requestId: payData.requestId }
        });
      } else {
        await supabase.from('transactions').update({ 
            status: 'FAILED_VENDING',
            error_code: payData.code,
            api_response: `Inner Status: ${actualStatus}`
        }).eq('tx_hash', txHash);

        try { await sendTelegramAlert(`❌ *TX FAILED AT PROVIDER*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n⚠️ VTpass returned an explicit failed status (${actualStatus}).`); } catch (err) {}
        return NextResponse.json({ success: false, message: "The provider network is currently unstable. Please try again.", code: "INNER_FAIL" }, { status: 200 }); 
      }

    } else {
      const friendlyMessage = error_messages[payData.code as string] || "Service is temporarily undergoing maintenance. Please try again later.";
      const rawTechnicalError = payData.response_description || payData.content?.errors || "Unknown VTpass Rejection";

      await supabase.from('transactions').update({ 
          status: 'FAILED_VENDING',
          error_code: payData.code,
          api_response: rawTechnicalError
      }).eq('tx_hash', txHash);

      try { await sendTelegramAlert(`❌ *VENDING REJECTED*\n🛒 *Product:* ${network} ${serviceCategory}\n👤 *User:* ${billersCode || phone}\n🚨 *Admin Error:* Code ${payData.code} - ${rawTechnicalError}\n🗣 *User Saw:* ${friendlyMessage}`); } catch (err) {}

      return NextResponse.json({ success: false, message: friendlyMessage, code: payData.code }, { status: 200 }); 
    }

  } catch (error: any) {
    return NextResponse.json({ success: false, code: "SYSTEM_CRASH", message: "Transaction failed due to a system error. Please try again." }, { status: 500 });
  }
}
