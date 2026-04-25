// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

export async function POST(req: Request) {
  try {
    const { platform, platform_id, text } = await req.json();

    // 1. Identify the User across any platform
    let columnToSearch = '';
    if (platform === 'TELEGRAM') columnToSearch = 'telegram_chat_id';
    if (platform === 'WHATSAPP') columnToSearch = 'whatsapp_number';
    if (platform === 'X') columnToSearch = 'x_twitter_id';

    const { data: identity } = await supabase
      .from('deai_identities')
      .select('user_id, deai_pin, is_active, abapay_users(verified_phone)')
      .eq(columnToSearch, platform_id)
      .single();

    if (!identity || !identity.is_active) {
      return NextResponse.json({ 
        action: 'REPLY', 
        message: "🔒 **Unauthorized**\nPlease link your AbaPay account on the web dashboard to use this agent." 
      });
    }

    // 2. PIN CHECKOUT PHASE
    const { data: session } = await supabase
      .from('deai_sessions')
      .select('*')
      .eq('chat_id', platform_id)
      .eq('status', 'AWAITING_PIN')
      .single();

    if (session) {
      if (new Date(session.expires_at) < new Date()) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ action: 'REPLY', message: "⏳ Session expired. Please start over." });
      }

      if (text.trim() === identity.deai_pin) {
        // --- RELAYER EXECUTION HAPPENS HERE IN THE FUTURE ---
        // 1. Call Smart Contract V2 to pull funds from identity.user_id
        // 2. Hit VTPass API

        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        
        return NextResponse.json({ 
          action: 'SUCCESS_RECEIPT', 
          message: `🎉 **Success!**\n\nSent ₦${session.intent_data.amount_ngn} ${session.intent_data.provider} to ${session.intent_data.destination_account}.\n\n*Relayer executed via ${platform}.*` 
        });
      } else {
        return NextResponse.json({ action: 'REPLY', message: "❌ Incorrect PIN." });
      }
    }

    // 3. AI INTENT ROUTING (If not in a checkout state)
    const fallbackModels = ["gemini-2.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"];
    let intentData = null;

    for (const modelName of fallbackModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
        const prompt = `
          Extract transaction details into strict JSON:
          { "intent": "VEND_AIRTIME" | "VEND_DATA" | "UNKNOWN", "provider": "MTN" | "AIRTEL" | "GLO" | "9MOBILE" | null, "amount_ngn": number | null, "destination_account": string | null }
          User Message: "${text}"
        `;
        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
        break; 
      } catch (e) { continue; }
    }

    if (!intentData || intentData.intent === "UNKNOWN") {
      return NextResponse.json({ action: 'REPLY', message: "I didn't catch that. Try: 'Buy 2k MTN for 08123456789'" });
    }

    // Save state
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);
    await supabase.from('deai_sessions').upsert({
      chat_id: platform_id, platform: platform, intent_data: intentData, status: 'AWAITING_PIN', expires_at: expiresAt.toISOString()
    }, { onConflict: 'chat_id' });

    // Return the payload so the specific platform can render its own buttons
    return NextResponse.json({ 
      action: 'REQUIRE_TOKEN_SELECTION', 
      intentData: intentData,
      message: `🤖 **AbaPay Checkout**\n\n₦${intentData.amount_ngn} ${intentData.provider} to ${intentData.destination_account}.\n\nReply with your 4-digit PIN to confirm.`
    });

  } catch (error) {
    console.error("Core Engine Error:", error);
    return NextResponse.json({ action: 'ERROR' });
  }
}
