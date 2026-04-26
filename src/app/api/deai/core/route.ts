// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

const detectNetwork = (phone: string) => {
  if (!phone) return null;
  const prefix = phone.substring(0, 4);
  if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) return "mtn";
  if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) return "airtel";
  if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) return "glo";
  if (["0809","0817","0818","0908","0909"].includes(prefix)) return "etisalat";
  return null;
};

// ⚡ SIMULATED VERIFICATION API
async function verifyAccount(intent: string, account: string, type?: string) {
    if (intent === 'ELECTRICITY') {
        return { success: true, customer_name: "Oluwafemi Olagoke", min_amount: 1000, max_amount: 50000 };
    }
    return { success: true, customer_name: "Verified User", min_amount: 100, max_amount: 100000 };
}

export async function POST(req: Request) {
  try {
    const { platform, platform_id, text } = await req.json();

    let columnToSearch = platform === 'TELEGRAM' ? 'telegram_chat_id' : platform === 'WHATSAPP' ? 'whatsapp_number' : 'x_twitter_id';
    const { data: identity } = await supabase
      .from('deai_identities')
      .select(`deai_pin, is_active, user_id, abapay_global_users(wallet_address, fiat_balance_ngn, country_code)`)
      .eq(columnToSearch, platform_id).single();

    if (!identity || !identity.is_active) {
      return NextResponse.json({ action: 'REPLY', message: "🔒 **Unauthorized**\nPlease link your wallet on the AbaPay dashboard to use this agent." });
    }

    const globalUser: any = Array.isArray(identity.abapay_global_users) ? identity.abapay_global_users[0] : identity.abapay_global_users;
    const currentCountry = globalUser?.country_code || 'NG';
    const currencySymbol = currentCountry === 'NG' ? '₦' : (currentCountry === 'GH' ? 'GH₵' : '$');

    const { data: session } = await supabase.from('deai_sessions').select('*').eq('chat_id', platform_id).single();
    const userInput = text.trim().toLowerCase();

    // ESCAPE HATCH & GREETING
    if (userInput === 'cancel' || userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: `👋 **Welcome to AbaPay AI!**\n\nI can help you pay bills and send crypto instantly.\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n📜 _Check my recent transactions_\n🌍 _Change my country to Ghana_` 
      });
    }

    // STATE: PROCESSING LOCK
    if (session?.status === 'PROCESSING') {
        // If they ask for history while processing, we can let them check it.
        if (userInput.includes('history') || userInput.includes('status') || userInput.includes('recent')) {
            // Let the logic fall through to the AI so it hits the TRANSACTION_HISTORY intent
        } else {
            return NextResponse.json({ action: 'REPLY', message: "⏳ Your previous transaction is currently processing. Type **Status** to check your history." });
        }
    }

    let isContinuingToAI = false;

    // STATE: PIN CONFIRMATION
    if (session?.status === 'AWAITING_PIN') {
      if (text.trim() === identity.deai_pin) {
        // Lock the state to processing
        await supabase.from('deai_sessions').update({ status: 'PROCESSING' }).eq('chat_id', platform_id);
        
        // ⚡ HERE IS WHERE YOU CALL YOUR BLOCKCHAIN/PAYMENT API ⚡

        return NextResponse.json({ 
          action: 'REPLY', 
          message: `✅ **PIN Verified!**\n\n⏳ *Processing your ${session.intent_data.selected_token} transaction...*\n\nType **Status** or **History** in a few moments to check the result.` 
        });
      }
      
      if (/^\d{4}$/.test(text.trim())) {
        return NextResponse.json({ action: 'REPLY', message: "❌ Incorrect PIN. Reply with your correct PIN, or type **Cancel**." });
      } else {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        isContinuingToAI = true; 
      }
    } 
    // STATE: TOKEN SELECTION
    else if (session?.status === 'AWAITING_TOKEN') {
      const tokenMap: Record<string, string> = { '1': 'Fiat', '2': 'USDT', '3': 'USDC', '4': 'cUSD' };
      const selected = tokenMap[userInput];

      if (!selected) return NextResponse.json({ action: 'REPLY', message: "❌ Invalid selection. Reply with **1**, **2**, **3**, or **4**." });

      session.intent_data.selected_token = selected;
      await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: session.intent_data, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

      const total = (session.intent_data.amount_ngn || 0) + (session.intent_data.fee || 0);
      return NextResponse.json({
          action: 'REPLY',
          message: `🤖 **Final Checkout**\n\nService: ${session.intent_data.intent}\nAccount: ${session.intent_data.destination_account}\nName: ${session.intent_data.verified_name || 'N/A'}\nAmount: ${currencySymbol}${session.intent_data.amount_ngn}\nPayment: **${selected}**\n**Total: ${currencySymbol}${total}**\n\n🔒 Reply with your **4-digit PIN** to confirm.`
      });
    }
    // STATE: METER TYPE
    else if (session?.status === 'AWAITING_METER_TYPE') {
        const typeMap: Record<string, string> = { '1': 'prepaid', '2': 'postpaid' };
        const selectedType = typeMap[userInput];

        if (!selectedType) return NextResponse.json({ action: 'REPLY', message: "❌ Please reply with **1** for Prepaid or **2** for Postpaid." });
        
        session.intent_data.meter_type = selectedType;

        const verification = await verifyAccount(session.intent_data.intent, session.intent_data.destination_account, selectedType);
        
        if (!verification.success) {
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
            return NextResponse.json({ action: 'REPLY', message: `❌ Verification failed. Please check the meter number and try again.` });
        }

        session.intent_data.verified_name = verification.customer_name;
        session.intent_data.min_amount = verification.min_amount;
        session.intent_data.max_amount = verification.max_amount;

        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: session.intent_data, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

        return NextResponse.json({ action: 'REPLY', message: `✅ **Verified!**\nName: ${verification.customer_name}\nMin Amount: ${currencySymbol}${verification.min_amount}\n\nPlease reply with the **Amount** you wish to pay, your **Phone Number**, and **Email Address** (e.g., "5000 08012345678 test@email.com").` });
    }
    // STATE: DETAILS
    else if (session?.status === 'AWAITING_DETAILS') {
       isContinuingToAI = true;
    } else {
       isContinuingToAI = true;
    }

    // --- AI ROUTING ---
    if (!isContinuingToAI && session?.status !== 'PROCESSING') return NextResponse.json({ success: true });

    const fallbackModels = ["gemini-3-flash-preview", "gemini-2.5-flash"];
    let intentData = null;
    const previousContext = session?.status === 'AWAITING_DETAILS' ? JSON.stringify(session.intent_data) : "None";

    for (const modelName of fallbackModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
        const prompt = `
          Extract user intent into JSON. 
          Categories: VEND_AIRTIME, ELECTRICITY, EDUCATION, TV, CHANGE_COUNTRY, TRANSACTION_HISTORY, UNKNOWN.
          
          Previous Context: ${previousContext} (Merge new details into this if present).
          
          Rules:
          - If the user asks for their recent transactions, history, or status of a payment, intent is TRANSACTION_HISTORY.
          - If the user asks to change country or region, intent is CHANGE_COUNTRY.
          - For 9mobile, use "etisalat".
          
          Return JSON: { "intent": string, "provider": string, "amount_ngn": number, "destination_account": string, "phone": string, "email": string }
          Message: "${text}"
        `;
        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
        if (intentData) break; 
      } catch (e) { continue; }
    }

    if (!intentData) throw new Error("AI parsing failed.");

    // --- LOGIC GATES ---

    if (intentData.intent === 'UNKNOWN') {
       return NextResponse.json({ action: 'REPLY', message: "🤔 I didn't quite catch that. Type **Help** to see what I can do!" });
    }

    if (intentData.intent === 'CHANGE_COUNTRY') {
        return NextResponse.json({ action: 'REPLY', message: `🌍 **Country Selection**\n\nTo change your region, log into your AbaPay Web Dashboard. Your bot will automatically sync!` });
    }

    // ⚡ GATE: TRANSACTION HISTORY ⚡
    if (intentData.intent === 'TRANSACTION_HISTORY') {
        // Clear any stuck sessions if they are just checking history
        if (session?.status !== 'PROCESSING') {
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        }

        // NOTE: Change 'transactions' to your actual AbaPay transactions table name
        const { data: recentTxs, error } = await supabase
            .from('transactions') 
            .select('*')
            .eq('user_id', identity.user_id)
            .order('created_at', { ascending: false })
            .limit(3);

        if (!recentTxs || recentTxs.length === 0) {
            return NextResponse.json({ action: 'REPLY', message: "📜 You don't have any recent transactions yet." });
        }

        let msg = "📜 **Your Recent Transactions:**\n\n";
        recentTxs.forEach((tx, index) => {
            // Adjust 'service_type', 'amount', 'status' to match your DB columns
            msg += `${index + 1}. **${tx.service_type || 'Payment'}** - ${currencySymbol}${tx.amount}\n`;
            msg += `Status: ${tx.status} | Date: ${new Date(tx.created_at).toLocaleDateString()}\n\n`;
        });

        return NextResponse.json({ action: 'REPLY', message: msg });
    }

    // GATE 1: ELECTRICITY REQUIRES METER TYPE
    if (intentData.intent === 'ELECTRICITY' && !intentData.meter_type) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_METER_TYPE', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `💡 Electricity Payment for Meter: **${intentData.destination_account}**\n\nIs this Prepaid or Postpaid?\n\nReply with:\n**1** for Prepaid\n**2** for Postpaid` });
    }

    // GATE 2: MISSING INFO FOR VERIFIED SERVICES
    let missing = [];
    if (!intentData.amount_ngn) missing.push("the **Amount**");
    if (['ELECTRICITY', 'TV', 'EDUCATION'].includes(intentData.intent)) {
        if (!intentData.phone) missing.push("your **Phone Number**");
        if (!intentData.email) missing.push("your **Email Address**");
    }

    if (missing.length > 0) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `I need a bit more info. Please reply with ${missing.join(", ")}.` });
    }

    // GATE 3: MIN/MAX VALIDATION
    if (intentData.min_amount && intentData.amount_ngn < intentData.min_amount) {
        intentData.amount_ngn = null; 
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `❌ The minimum amount for this meter is ${currencySymbol}${intentData.min_amount}. Please reply with a higher amount.` });
    }

    // FEE ASSIGNMENT
    intentData.fee = ['ELECTRICITY', 'TV', 'EDUCATION'].includes(intentData.intent) ? 100 : 0;

    // GATE 4: TOKEN SELECTION
    if (!intentData.selected_token) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_TOKEN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({
            action: 'REPLY',
            message: `🪙 **Select Payment Method**\n\n1️⃣ Fiat Balance (${currencySymbol}${globalUser.fiat_balance_ngn || 0})\n2️⃣ USDT\n3️⃣ USDC\n4️⃣ cUSD\n\n*Reply with the number (e.g., 2).*`
        });
    }

  } catch (error) {
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error. Please try again." });
  }
}
