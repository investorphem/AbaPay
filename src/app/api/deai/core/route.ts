// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import { categorizeDataPlan } from '@/lib/dataCategories';

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
      .select(`deai_pin, is_active, user_id, abapay_global_users(wallet_address, fiat_balance_ngn)`)
      .eq(columnToSearch, platform_id).single();

    if (!identity || !identity.is_active) {
      return NextResponse.json({ action: 'REPLY', message: "🔒 **Unauthorized**\nPlease link your wallet on the AbaPay dashboard to use this agent." });
    }

    // 2. State Machine Logic
    const { data: session } = await supabase.from('deai_sessions').select('*').eq('chat_id', platform_id).single();
    const userInput = text.trim().toLowerCase();

    // ESCAPE HATCH: Let the user cancel manually
    if (userInput === 'cancel' || userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: "👋 **Welcome to AbaPay AI!**\n\nI can help you pay bills and send crypto instantly. Tell me what you'd like to do!\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n💬 _Buy 1.5GB data for 08012345678_" 
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
        // SUCCESS: Wipe session and execute
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ 
          action: 'SUCCESS_RECEIPT', 
          message: `🎉 **Transaction Successful!**\n\nService: ${session.intent_data.intent}\nAmount: ₦${session.intent_data.amount_ngn}\nRecipient: ${session.intent_data.destination_account}\n\n*Receipt sent to your AbaPay history.*` 
        });
      }
      
      // THE SMART RESET 
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

    const fallbackModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];
    let intentData = null;

    const previousContext = session?.status === 'AWAITING_DETAILS' ? JSON.stringify(session.intent_data) : "None";

    for (const modelName of fallbackModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
        const prompt = `
          You are the AbaPay DeAI Agent. Extract user intent into JSON.
          Categories: VEND_AIRTIME, VEND_DATA, ELECTRICITY, EDUCATION, TV, BANK_TRANSFER, GREETING, UNKNOWN.
          
          Previous Context: ${previousContext}
          If Previous Context is not "None", merge the new Message details into the Previous Context.
          
          Rules:
          - If the user says hello, hi, start, or help, intent is GREETING.
          - If the request is gibberish, intent is UNKNOWN.
          - For 9mobile, use "etisalat".
          - If amount is missing, leave as null.
          - If destination account/phone is missing, leave as null.
          - If they mention a "meter", intent is ELECTRICITY.
          - If they mention "WAEC" or "JAMB", intent is EDUCATION.

          Return: { "intent": string, "provider": string, "amount_ngn": number, "destination_account": string, "quantity": number }
          Message: "${text}"
        `;

        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
        if (intentData) break; 
      } catch (e) { continue; }
    }

    if (!intentData) throw new Error("All AI models failed.");

    // Handle Greetings & Unknowns explicitly
    if (intentData.intent === 'GREETING' || intentData.intent === 'UNKNOWN') {
       await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
       return NextResponse.json({ 
         action: 'REPLY', 
         message: "👋 **Welcome to AbaPay AI!**\n\nTell me what you'd like to do!\n\n*Examples:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n💬 _Buy 1.5GB data for 08012345678_" 
       });
    }

    // 4. Missing Information Guardrails & Dynamic Echo
    if (intentData.intent === 'VEND_AIRTIME') {
      if (!intentData.provider) intentData.provider = detectNetwork(intentData.destination_account);
      
      // If crucial info is missing, echo back what we know and ask for the rest
      if (!intentData.amount_ngn || !intentData.destination_account) {
         await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString()
         }, { onConflict: 'chat_id' });

         // Construct the friendly echo
         let understood = `I see you want to buy **Airtime**`;
         if (intentData.provider) understood += ` for **${intentData.provider.toUpperCase()}**`;
         if (intentData.destination_account) understood += ` to **${intentData.destination_account}**`;
         if (intentData.amount_ngn) understood += ` for **₦${intentData.amount_ngn}**`;
         
         let missing = [];
         if (!intentData.amount_ngn) missing.push("the **amount**");
         if (!intentData.destination_account) missing.push("the **phone number**");
         
         return NextResponse.json({ action: 'REPLY', message: `💡 ${understood}.\n\nTo proceed, please reply with ${missing.join(" and ")}.` });
      }

      if (intentData.amount_ngn < 100) {
         await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
         return NextResponse.json({ action: 'REPLY', message: "❌ Minimum airtime is ₦100. Please start over with a valid amount." });
      }
    }

    if (intentData.intent === 'ELECTRICITY' || intentData.intent === 'BANK_TRANSFER' || intentData.intent === 'EDUCATION') {
        intentData.fee = 100;
    }

    // 5. Ready for Checkout! Save session and ask for PIN
    await supabase.from('deai_sessions').upsert({
      chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString()
    }, { onConflict: 'chat_id' });

    const total = (intentData.amount_ngn || 0) + (intentData.fee || 0);
    return NextResponse.json({ 
      action: 'REPLY', 
      message: `🤖 **AbaPay Checkout**\n\nService: ${intentData.intent.replace('_', ' ')}\nAccount: ${intentData.destination_account}\nAmount: ₦${intentData.amount_ngn}\nFee: ₦${intentData.fee || 0}\n**Total: ₦${total}**\n\nReply with your 4-digit PIN to confirm.`
    });

  } catch (error) {
    console.error("🚨 Brain Error Catch Block:", error);
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error or AI timeout. Please try again in a moment." });
  }
}
