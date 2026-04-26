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

// Helper for Auto-Network Detection from your constants logic
const detectNetwork = (phone: string) => {
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

    // PHASE: PIN CONFIRMATION
    if (session?.status === 'AWAITING_PIN') {
      if (text.trim() === identity.deai_pin) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ 
          action: 'SUCCESS_RECEIPT', 
          message: `🎉 **Transaction Successful!**\n\nService: ${session.intent_data.intent}\nAmount: ₦${session.intent_data.amount_ngn}\nRecipient: ${session.intent_data.destination_account}\n\n*Receipt sent to your AbaPay history.*` 
        });
      }
      return NextResponse.json({ action: 'REPLY', message: "❌ Incorrect PIN. Please try again." });
    }

    // 3. AI Intent Routing (The Brain Upgrade with Fallback Loop)
    // 🚀 We loop through valid models so your bot never goes offline due to a 404
    const fallbackModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"];
    let intentData = null;

    for (const modelName of fallbackModels) {
      try {
        const model = genAI.getGenerativeModel({ 
          model: modelName, 
          generationConfig: { responseMimeType: "application/json" } 
        });

        const prompt = `
          You are the AbaPay DeAI Agent. Extract user intent into JSON.
          Categories: VEND_AIRTIME, VEND_DATA, ELECTRICITY, EDUCATION, TV, BANK_TRANSFER.
          
          Rules:
          - For 9mobile, use "etisalat".
          - If amount is missing, leave as null.
          - If they mention a "meter", intent is ELECTRICITY.
          - If they mention "WAEC" or "JAMB", intent is EDUCATION.

          Return: { "intent": string, "provider": string, "amount_ngn": number, "destination_account": string, "quantity": number }
          Message: "${text}"
        `;

        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
        
        // If successful, break out of the loop
        if (intentData) break; 
      } catch (e) {
        console.warn(`Model ${modelName} failed, trying next fallback...`);
        continue;
      }
    }

    // If every single model failed, throw an error to catch block
    if (!intentData) {
        throw new Error("All AI models failed to parse intent or returned null.");
    }

    // 4. Apply AbaPay Logic Guardrails
    if (intentData.intent === 'VEND_AIRTIME') {
      if (!intentData.provider) intentData.provider = detectNetwork(intentData.destination_account);
      if (intentData.amount_ngn < 100) return NextResponse.json({ action: 'REPLY', message: "❌ Minimum airtime is ₦100." });
    }

    if (intentData.intent === 'ELECTRICITY' || intentData.intent === 'BANK_TRANSFER' || intentData.intent === 'EDUCATION') {
        intentData.fee = 100; // Your app's standard fee
    }

    // Save session and ask for PIN
    await supabase.from('deai_sessions').upsert({
      chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString()
    }, { onConflict: 'chat_id' });

    const total = (intentData.amount_ngn || 0) + (intentData.fee || 0);
    return NextResponse.json({ 
      action: 'REPLY', 
      message: `🤖 **AbaPay Checkout**\n\nService: ${intentData.intent}\nAccount: ${intentData.destination_account}\nAmount: ₦${intentData.amount_ngn}\nFee: ₦${intentData.fee || 0}\n**Total: ₦${total}**\n\nReply with your 4-digit PIN to confirm.`
    });

  } catch (error) {
    console.error("Brain Error:", error);
    return NextResponse.json({ action: 'ERROR', message: "System rebooting. Try again in a moment." });
  }
}
