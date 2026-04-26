// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

// Helper for Auto-Network Detection
const detectNetwork = (phone: string) => {
  if (!phone) return null;
  const prefix = phone.substring(0, 4);
  if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) return "mtn";
  if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) return "airtel";
  if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) return "glo";
  if (["0809","0817","0818","0908","0909"].includes(prefix)) return "etisalat";
  return null;
};

export async function POST(req: Request) {
  try {
    const { platform, platform_id, text } = await req.json();

    // 1. Identify User
    let columnToSearch = platform === 'TELEGRAM' ? 'telegram_chat_id' : platform === 'WHATSAPP' ? 'whatsapp_number' : 'x_twitter_id';
    const { data: identity } = await supabase
      .from('deai_identities')
      .select(`deai_pin, is_active, user_id, abapay_global_users(wallet_address, fiat_balance_ngn, country_code)`)
      .eq(columnToSearch, platform_id).single();

    if (!identity || !identity.is_active) {
      return NextResponse.json({ action: 'REPLY', message: "🔒 **Unauthorized**\nPlease link your wallet on the AbaPay dashboard to use this agent." });
    }

        // Safely extract the user data whether Supabase returns an array or an object
    const globalUser: any = Array.isArray(identity.abapay_global_users) 
      ? identity.abapay_global_users[0] 
      : identity.abapay_global_users;

    const currentCountry = globalUser?.country_code || 'NG';
    const currencySymbol = currentCountry === 'NG' ? '₦' : (currentCountry === 'GH' ? 'GH₵' : '$');


    // 2. State Machine Logic
    const { data: session } = await supabase.from('deai_sessions').select('*').eq('chat_id', platform_id).single();
    const userInput = text.trim().toLowerCase();

    // ESCAPE HATCH: Cancel or Start
    if (userInput === 'cancel' || userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: `👋 **Welcome to AbaPay AI!** (Region: ${currentCountry})\n\nI can help you pay bills and send crypto instantly.\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n💬 _Buy 1.5GB data for 08012345678_\n🌍 _Change my country to Ghana_` 
      });
    }

    // PHASE: PIN CONFIRMATION
    let isContinuingToAI = true;

    if (session?.status === 'AWAITING_PIN') {
      if (session.expires_at && new Date(session.expires_at) < new Date()) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ action: 'REPLY', message: "⏳ Checkout session expired. Please start your request over." });
      }

      if (text.trim() === identity.deai_pin) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ 
          action: 'SUCCESS_RECEIPT', 
          message: `🎉 **Transaction Successful!**\n\nService: ${session.intent_data.intent}\nAmount: ${currencySymbol}${session.intent_data.amount_ngn}\nRecipient: ${session.intent_data.destination_account}\n\n*Receipt sent to your AbaPay history.*` 
        });
      }
      
      if (/^\d{4}$/.test(text.trim())) {
        return NextResponse.json({ action: 'REPLY', message: "❌ Incorrect PIN.\n\nReply with your correct 4-digit PIN, or type **Cancel** to start over." });
      } else {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      }
    } else if (session?.status === 'AWAITING_DETAILS') {
       isContinuingToAI = true;
    }

    // 3. AI Intent Routing
    if (!isContinuingToAI) return NextResponse.json({ success: true });

    const fallbackModels = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-1.5-pro"];
    let intentData = null;

    const previousContext = session?.status === 'AWAITING_DETAILS' ? JSON.stringify(session.intent_data) : "None";

    for (const modelName of fallbackModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
        const prompt = `
          You are the AbaPay DeAI Agent. Extract user intent into JSON.
          Categories: VEND_AIRTIME, VEND_DATA, ELECTRICITY, EDUCATION, TV, BANK_TRANSFER, CHANGE_COUNTRY, UNKNOWN.
          
          Previous Context: ${previousContext}
          If Previous Context is not "None", merge the new Message details into the Previous Context.
          
          Rules:
          - If the user asks to change country or region, intent is CHANGE_COUNTRY.
          - If the request is gibberish, intent is UNKNOWN.
          - For 9mobile, use "etisalat".
          - If amount is missing, leave as null.
          - If destination account/phone is missing, leave as null.
          - If they mention a "meter", intent is ELECTRICITY.
          - If they mention "WAEC" or "JAMB", intent is EDUCATION.

          Return JSON: { "intent": string, "provider": string, "amount_ngn": number, "destination_account": string, "quantity": number, "country": string }
          Message: "${text}"
        `;

        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
        if (intentData) break; 
      } catch (e) { continue; }
    }

    if (!intentData) throw new Error("All AI models failed.");

    if (intentData.intent === 'UNKNOWN') {
       return NextResponse.json({ action: 'REPLY', message: "🤔 I didn't quite catch that. Type **Help** to see what I can do, or try rephrasing your request!" });
    }

    if (intentData.intent === 'CHANGE_COUNTRY') {
        return NextResponse.json({ action: 'REPLY', message: `🌍 Country Selection Menu:\n\nTo change your region, please log into your AbaPay Web Dashboard and update your profile settings. Your bot will automatically sync to your new local currency!` });
    }

    // 4. Missing Information Guardrails (For ALL Services)
    if (intentData.intent === 'VEND_AIRTIME' && !intentData.provider) {
      intentData.provider = detectNetwork(intentData.destination_account);
    }

    // Check what is missing based on service type
    let missing = [];
    const requiresAmount = ['VEND_AIRTIME', 'BANK_TRANSFER', 'ELECTRICITY'].includes(intentData.intent);
    
    if (requiresAmount && !intentData.amount_ngn) missing.push("the **amount**");
    if (!intentData.destination_account) missing.push("the **target account/phone/meter number**");

    if (missing.length > 0) {
        // We save the state WITHOUT wiping it so they can answer
        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString()
        }, { onConflict: 'chat_id' });

        let understood = `I see you want to process a **${intentData.intent.replace('_', ' ')}** transaction`;
        if (intentData.provider) understood += ` for **${intentData.provider.toUpperCase()}**`;
        if (intentData.destination_account) understood += ` to **${intentData.destination_account}**`;
        if (intentData.amount_ngn) understood += ` for **${currencySymbol}${intentData.amount_ngn}**`;
         
        return NextResponse.json({ action: 'REPLY', message: `💡 ${understood}.\n\nTo proceed, please reply with ${missing.join(" and ")}.` });
    }

    // 5. Min/Max Validation (Without deleting memory!)
    if (intentData.intent === 'VEND_AIRTIME' && intentData.amount_ngn < 100) {
        // We reset the amount in memory, but KEEP the phone number and state!
        intentData.amount_ngn = null; 
        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString()
        }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `❌ Minimum airtime is ${currencySymbol}100. Please reply with a valid amount.` });
    }

    // Fee Assignment
    if (['ELECTRICITY', 'BANK_TRANSFER', 'EDUCATION', 'TV', 'VEND_DATA'].includes(intentData.intent)) {
        intentData.fee = 100;
    } else {
        intentData.fee = 0;
    }

    // 6. Ready for Checkout! Save session and ask for PIN
    await supabase.from('deai_sessions').upsert({
      chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString()
    }, { onConflict: 'chat_id' });

    const total = (intentData.amount_ngn || 0) + (intentData.fee || 0);
    return NextResponse.json({ 
      action: 'REPLY', 
      message: `🤖 **AbaPay Checkout**\n\nService: ${intentData.intent.replace('_', ' ')}\nAccount: ${intentData.destination_account}\nAmount: ${currencySymbol}${intentData.amount_ngn}\nFee: ${currencySymbol}${intentData.fee}\n**Total: ${currencySymbol}${total}**\n\nReply with your 4-digit PIN to confirm.`
    });

  } catch (error) {
    console.error("🚨 Brain Error Catch Block:", error);
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error or AI timeout. Please try again in a moment." });
  }
}
