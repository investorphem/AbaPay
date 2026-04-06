// src/app/api/webhook/vtpass/route.ts
import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Verify this is actually a transaction update from VTpass
    if (body.type === 'transaction-update' && body.data) {
      const { code, content, requestId, response_description, amount } = body.data;
      const innerStatus = content?.transactions?.status;

      // --- SCENARIO 1: DELAYED SUCCESS ---
      if (code === '000' || innerStatus === 'delivered') {
        await supabase
          .from('transactions')
          .update({ status: 'SUCCESS' })
          .eq('request_id', requestId); 
          
        return NextResponse.json({ received: true, status: 'acknowledged_success' });
      }

      // --- SCENARIO 2: TRANSACTION REVERSAL (BOUNCED) ---
      if (code === '040' || innerStatus === 'reversed') {
         // 1. Update the database to flag this for a crypto refund
         const { data: txData } = await supabase
          .from('transactions')
          .update({ status: 'REVERSED_NEEDS_REFUND' })
          .eq('request_id', requestId)
          .select()
          .single();

         // 2. Fire an EMERGENCY Telegram Alert to the Admin
         const userWallet = txData?.wallet_address || "Unknown";
         const cryptoAmount = txData?.amount_usdt || "Unknown";
         
         const alertMessage = `⚠️ *VTPASS REVERSAL ALERT*\n\nVTpass bounced a delayed transaction and refunded your Naira wallet.\n\n🛒 *Req ID:* ${requestId}\n💰 *Naira Refunded:* ₦${amount}\n🛑 *Reason:* ${response_description}\n\n🚨 *ACTION REQUIRED:* You need to manually refund the user's crypto from the Vault.\n👤 *User Wallet:* \`${userWallet}\`\n🪙 *Crypto Owed:* $${cryptoAmount}`;

         await sendTelegramAlert(alertMessage);

         return NextResponse.json({ received: true, status: 'acknowledged_reversal' });
      }
    }

    // Acknowledge other webhook types so VTpass doesn't keep retrying
    return NextResponse.json({ received: true, message: 'Unhandled webhook type ignored.' });

  } catch (error: any) {
    console.error("Webhook Error:", error.message);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}
