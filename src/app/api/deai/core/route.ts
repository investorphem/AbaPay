// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

// Using the fastest, most stable model to prevent Vercel Timeouts
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

// Auto-Detect Network
const detectNetwork = (phone: string) => {
  if (!phone) return null;
  const prefix = phone.substring(0, 4);
  if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) return "mtn";
  if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) return "airtel";
  if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) return "glo";
  if (["0809","0817","0818","0908","0909"].includes(prefix)) return "etisalat";
  return null;
};

// Simulated VTPass API
async function verifyAccount(intent: string, account: string, type?: string) {
    if (intent === 'ELECTRICITY') return { success: true, customer_name: "Oluwafemi Olagoke", min_amount: 1000, max_amount: 50000 };
    if (intent === 'TV') return { success: true, customer_name: "AbaPay User", min_amount: 1500, max_amount: 100000 };
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

    // 1. ESCAPE HATCH & GREETING
    if (userInput === 'cancel' || userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: `👋 **Welcome to AbaPay AI!**\n\nI can help you pay bills and send crypto instantly.\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n📜 _Check my recent transactions_` 
      });
    }

    // 2. PROCESSING LOCK
    if (session?.status === 'PROCESSING') {
        if (userInput.includes('history') || userInput.includes('status') || userInput.includes('recent')) {
            // Let it fall through to fetch history
        } else {
            return NextResponse.json({ action: 'REPLY', message: "⏳ Your previous transaction is currently processing. Type **Status** to check your history." });
        }
    }

    let isContinuingToAI = false;

    // 3. STATE: PIN CONFIRMATION
    if (session?.status === 'AWAITING_PIN') {
      if (text.trim() === identity.deai_pin) {
        await supabase.from('deai_sessions').update({ status: 'PROCESSING' }).eq('chat_id', platform_id);
        // ⚡ BLOCKCHAIN / VTPASS PAYMENT LOGIC GOES HERE ⚡
        return NextResponse.json({ action: 'REPLY', message: `✅ **PIN Verified!**\n\n⏳ *Processing your ${session.intent_data.selected_token} transaction...*\n\nType **Status** in a few moments to check the result.` });
      }
      
      if (/^\d{4}$/.test(text.trim())) {
        return NextResponse.json({ action: 'REPLY', message: "❌ Incorrect PIN. Reply with your correct PIN, or type **Cancel**." });
      } else {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        isContinuingToAI = true; 
      }
    } 
    // 4. STATE: TOKEN SELECTION
    else if (session?.status === 'AWAITING_TOKEN') {
      const tokenMap: Record<string, string> = { '1': 'Fiat', '2': 'USDT', '3': 'USDC', '4': 'cUSD' };
      const selected = tokenMap[userInput];

      if (!selected) return NextResponse.json({ action: 'REPLY', message: "❌ Invalid selection. Reply with **1**, **2**, **3**, or **4**." });

      session.intent_data.selected_token = selected;
      await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: session.intent_data, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

      const total = (session.intent_data.amount_ngn || 0) + (session.intent_data.fee || 0);
      return NextResponse.json({
          action: 'REPLY',
          message: `🤖 **Final Checkout**\n\nService: ${session.intent_data.intent.replace('_', ' ')}\nAccount: ${session.intent_data.destination_account}\nName: ${session.intent_data.verified_name || 'N/A'}\nAmount: ${currencySymbol}${session.intent_data.amount_ngn}\nPayment: **${selected}**\n**Total: ${currencySymbol}${total}**\n\n🔒 Reply with your **4-digit PIN** to confirm.`
      });
    }
    // 5. STATE: METER/SMARTCARD TYPE
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
        
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: session.intent_data, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

        return NextResponse.json({ action: 'REPLY', message: `✅ **Verified!**\nName: ${verification.customer_name}\n\nPlease reply with the **Amount** you wish to pay, your **Phone Number**, and **Email Address** (e.g., "5000 08012345678 test@email.com").` });
    }
    // 6. STATE: AWAITING DETAILS
    else if (session?.status === 'AWAITING_DETAILS') {
       isContinuingToAI = true;
    } else {
       isContinuingToAI = true;
    }

    // --- AI ROUTING (Fast Generation) ---
    if (!isContinuingToAI && session?.status !== 'PROCESSING') return NextResponse.json({ success: true });

    let intentData = null;
    const previousContext = session?.status === 'AWAITING_DETAILS' ? JSON.stringify(session.intent_data) : "None";

    try {
        // Locked to 2.5-flash for maximum speed and zero timeouts
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const prompt = `
          Extract user intent into JSON. 
          Categories: VEND_AIRTIME, VEND_DATA, ELECTRICITY, EDUCATION, TV, BANK_TRANSFER, TRANSACTION_HISTORY, UNKNOWN.
          
          Previous Context: ${previousContext} (Merge new details into this if present).
          
          Rules:
          - If the user asks for history, intent is TRANSACTION_HISTORY.
          - If the request is gibberish, intent is UNKNOWN.
          
          Return JSON: { "intent": string, "provider": string, "amount_ngn": number, "destination_account": string, "phone": string, "email": string }
          Message: "${text}"
        `;
        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
    } catch (e) { 
        console.error("AI Error:", e);
        return NextResponse.json({ action: 'REPLY', message: "🚨 AI timeout. Please try sending your message again." });
    }

    if (!intentData) return NextResponse.json({ action: 'REPLY', message: "🚨 Parsing failed." });

    // --- LOGIC GATES ---

    if (intentData.intent === 'UNKNOWN') {
       return NextResponse.json({ action: 'REPLY', message: "🤔 I didn't quite catch that. Type **Help** to see what I can do!" });
    }

    if (intentData.intent === 'TRANSACTION_HISTORY') {
        if (session?.status !== 'PROCESSING') await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

        const { data: recentTxs, error } = await supabase
            .from('transactions').select('service_category, network, amount_naira, status, created_at, token_used')
            .eq('wallet_address', globalUser.wallet_address).order('created_at', { ascending: false }).limit(3);

        if (!recentTxs || recentTxs.length === 0) return NextResponse.json({ action: 'REPLY', message: "📜 You don't have any recent transactions yet." });

        let msg = "📜 **Your Recent Transactions:**\n\n";
        recentTxs.forEach((tx, index) => {
            const dateStr = new Date(tx.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
            msg += `${index + 1}. **${(tx.service_category || 'Payment').replace('_', ' ')}**\n`;
            msg += `Amount: ${currencySymbol}${tx.amount_naira} (${tx.token_used || 'Fiat'})\nStatus: ${tx.status} | Date: ${dateStr}\n\n`;
        });
        return NextResponse.json({ action: 'REPLY', message: msg });
    }

    // ⚡ THE FIX: STRICT MISSING INFO GATES FOR ALL SERVICES ⚡
    let missing = [];
    
    // Everyone needs an amount
    if (!intentData.amount_ngn) missing.push("the **Amount**");

    if (['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent)) {
        // Auto-detect network if they provided a phone number but no provider
        if (intentData.destination_account && !intentData.provider) {
             intentData.provider = detectNetwork(intentData.destination_account);
        }
        if (!intentData.destination_account) missing.push("the **Phone Number** to recharge");
        if (!intentData.provider) missing.push("the **Network Provider** (e.g. MTN, Airtel)");
    } 
    else if (['ELECTRICITY', 'TV'].includes(intentData.intent)) {
        if (!intentData.destination_account) missing.push("the **Meter/Smartcard Number**");
        if (!intentData.phone) missing.push("your **Phone Number**");
        if (!intentData.email) missing.push("your **Email Address**");
    }
    else if (['BANK_TRANSFER'].includes(intentData.intent)) {
        if (!intentData.destination_account) missing.push("the **Account Number**");
        if (!intentData.provider) missing.push("the **Bank Name**");
    }

    // If anything is missing, pause and ask!
    if (missing.length > 0) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `I need a bit more info to process this. Please reply with ${missing.join(", ")}.` });
    }

    // ⚡ GATE: ELECTRICITY REQUIRES METER TYPE (Only triggers IF amount, meter, phone, and email are provided)
    if (intentData.intent === 'ELECTRICITY' && !intentData.meter_type) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_METER_TYPE', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `💡 Electricity Payment for Meter: **${intentData.destination_account}**\n\nIs this Prepaid or Postpaid?\n\nReply with:\n**1** for Prepaid\n**2** for Postpaid` });
    }

    // MIN/MAX VALIDATION
    if (intentData.min_amount && intentData.amount_ngn < intentData.min_amount) {
        intentData.amount_ngn = null; 
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `❌ Minimum amount is ${currencySymbol}${intentData.min_amount}. Please reply with a valid amount.` });
    }

    // FEE ASSIGNMENT
    intentData.fee = ['ELECTRICITY', 'TV', 'EDUCATION'].includes(intentData.intent) ? 100 : 0;

    // ⚡ GATE: TOKEN SELECTION (Final step before PIN)
    if (!intentData.selected_token) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_TOKEN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({
            action: 'REPLY',
            message: `🪙 **Select Payment Method**\n\n1️⃣ Fiat Balance (${currencySymbol}${globalUser.fiat_balance_ngn || 0})\n2️⃣ USDT\n3️⃣ USDC\n4️⃣ cUSD\n\n*Reply with the number (e.g., 2).*`
        });
    }

  } catch (error) {
    console.error("System Error:", error);
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error. Please try again." });
  }
}
