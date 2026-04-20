import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { Resend } from 'resend'; 

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // VTpass sometimes wraps the payload in "data", and sometimes sends it raw. We handle both.
    const payload = body.data || body;
    const { code, content, requestId, response_description, amount } = payload;
    const innerStatus = content?.transactions?.status;

    if (!requestId) {
        return NextResponse.json({ received: true, message: 'No Request ID found in payload.' });
    }

    // 1. Fetch the existing pending transaction from the database
    const { data: txData, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (fetchError || !txData) {
       console.log("Webhook: Transaction not found for ID:", requestId);
       return NextResponse.json({ received: true, message: 'Transaction not found in DB.' });
    }

    // --- SCENARIO 1: DELAYED SUCCESS ---
    if (code === '000' || innerStatus === 'delivered' || innerStatus === 'successful') {

      // If it's already marked success, avoid duplicate notifications
      if (txData.status === 'SUCCESS') {
          return NextResponse.json({ received: true, status: 'already_processed' });
      }

      // Extract the delayed Token, PIN, or Units
      let dbPurchasedCode = payload.purchased_code || payload.token || payload.tokens || payload.Pin || content?.transactions?.token || content?.transactions?.purchased_code || null;
      let vendedUnits = payload.units || content?.transactions?.units || content?.transactions?.unit || null;

      // Aggressive Token Regex fallback for Electricity
      if (!dbPurchasedCode && txData.service_category === 'ELECTRICITY') {
          const rawPayloadString = JSON.stringify(payload);
          const tokenMatch = rawPayloadString.match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i);
          if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, '');
      }

      const alertTokenRef = dbPurchasedCode || content?.transactions?.transactionId || requestId || "Success";

      // Update the database
      await supabase
        .from('transactions')
        .update({ 
            status: 'SUCCESS', 
            purchased_code: dbPurchasedCode, 
            units: vendedUnits 
        })
        .eq('request_id', requestId); 

      // ⚡ TRIGGER ALL DELAYED NOTIFICATIONS ⚡
      const notifications = [];

      notifications.push(
        sendTelegramAlert(`✅ *DELAYED SALE SUCCESS (WEBHOOK)*\n🛒 *Product:* ${txData.network} ${txData.service_category}\n💰 *Naira:* ₦${txData.amount_naira}\n👤 *User:* ${txData.account_number}\n🧾 *Ref/Token:* ${alertTokenRef}`)
      );

      // ⚡ ONLY SEND SMS FOR TOKENS/PINS TO SAVE COST ⚡
      if (txData.service_category === 'ELECTRICITY' || txData.service_category === 'EDUCATION') {
        const typeLabel = txData.service_category === 'ELECTRICITY' ? 'Token' : 'PIN';
        const networkDisplay = txData.network || txData.service_category;
        
        notifications.push(
          sendAbaPaySms(txData.account_number, `AbaPay: Your ${networkDisplay} ${typeLabel} is ${alertTokenRef}. Amount: N${txData.amount_naira}. Thank you.`)
        );
      }

      if (txData.customer_email) {
        const emailPromise = resend.emails.send({
          from: 'AbaPay <receipts@abapays.com>',
          to: txData.customer_email,
          subject: `AbaPay Receipt - ${txData.network} ${txData.service_category}`,
          html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 10px;">
                  <h2 style="color: #333;">Delayed Transaction Completed ⚡</h2>
                  <p>Your recent AbaPay transaction for <strong>${txData.network} ${txData.service_category}</strong> has successfully completed processing:</p>
                  <div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
                      <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ₦${txData.amount_naira}</p>
                      <p style="margin: 5px 0;"><strong>Crypto Charged:</strong> ${txData.amount_usdt} ${txData.token_used || 'USD₮'}</p>
                      <p style="margin: 5px 0;"><strong>Account/Phone:</strong> ${txData.account_number}</p>
                  </div>
                  ${dbPurchasedCode ? `
                  <p style="margin-top: 20px; font-weight: bold;">Your PIN / Token is:</p>
                  <div style="background-color: #e0f2fe; color: #0284c7; padding: 15px; text-align: center; font-size: 24px; letter-spacing: 2px; font-weight: bold; border-radius: 8px; margin: 10px 0;">
                      ${dbPurchasedCode}
                  </div>
                  ` : `
                  <p style="margin-top: 20px;"><strong>Reference ID:</strong> ${alertTokenRef}</p>
                  `}
              </div>
          `
        });
        notifications.push(emailPromise);
      }

      // Distribute AbaPoints
      const earnedPoints = Number((txData.amount_naira / 1000).toFixed(2));
      if (earnedPoints > 0 && txData.wallet_address) {
          notifications.push(supabase.rpc('award_transaction_points', { 
              target_wallet: txData.wallet_address.toLowerCase(), 
              points_to_add: earnedPoints 
          }));
      }

      await Promise.allSettled(notifications);

      return NextResponse.json({ received: true, status: 'acknowledged_success' });
    }

    // --- SCENARIO 2: TRANSACTION REVERSAL (BOUNCED) ---
    if (code === '040' || innerStatus === 'reversed' || innerStatus === 'failed') {

       if (txData.status === 'REVERSED_NEEDS_REFUND' || txData.status === 'REFUNDED') {
           return NextResponse.json({ received: true, status: 'already_refunded' });
       }

       // 1. Update the database to flag this for a crypto refund
       await supabase
        .from('transactions')
        .update({ status: 'REVERSED_NEEDS_REFUND' })
        .eq('request_id', requestId);

       // 2. Fire an EMERGENCY Telegram Alert to the Admin
       const userWallet = txData.wallet_address || "Unknown";
       const cryptoAmount = txData.amount_usdt || "Unknown";

       const alertMessage = `⚠️ *VTPASS REVERSAL ALERT*\n\nVTpass bounced a delayed transaction and refunded your Naira wallet.\n\n🛒 *Req ID:* ${requestId}\n💰 *Naira Refunded:* ₦${amount || txData.amount_naira}\n🛑 *Reason:* ${response_description || 'Provider Reversal'}\n\n🚨 *ACTION REQUIRED:* You need to manually refund the user's crypto from the Vault.\n👤 *User Wallet:* \`${userWallet}\`\n🪙 *Crypto Owed:* $${cryptoAmount}`;

       await sendTelegramAlert(alertMessage);

       return NextResponse.json({ received: true, status: 'acknowledged_reversal' });
    }

    // Acknowledge other webhook types so VTpass doesn't keep retrying
    return NextResponse.json({ received: true, message: 'Unhandled webhook status ignored.' });

  } catch (error: any) {
    console.error("Webhook Error:", error.message);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}
