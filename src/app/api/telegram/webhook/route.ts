import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

// 1. Initialize Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

// Initialize Supabase (Uses Service Role Key to bypass RLS securely on the backend)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // ==========================================
    // SCENARIO 1: THE USER CLICKED A PAYMENT BUTTON
    // ==========================================
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id.toString();
      const selectedToken = body.callback_query.data.replace("TOKEN_", "");

      // 1. Update the session in Supabase to AWAITING_PIN
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 5);

      const { error } = await supabase
        .from('deai_sessions')
        .update({ 
          selected_token: selectedToken, 
          status: 'AWAITING_PIN',
          expires_at: expiresAt.toISOString()
        })
        .eq('chat_id', chatId)
        .eq('status', 'AWAITING_TOKEN');

      if (!error) {
        // 2. Ask for the PIN
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `✅ You selected **${selectedToken}**.\n\nPlease reply with your 4-digit AbaPay PIN to execute the transaction.\n*(Session expires in 5 minutes)*`,
            parse_mode: 'Markdown'
          })
        });
      }

      // 3. Stop the loading spinner on the button
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: body.callback_query.id })
      });

      return NextResponse.json({ success: true });
    }

    // ==========================================
    // SCENARIO 2: THE USER SENT A TEXT MESSAGE
    // ==========================================
    const text = body.message?.text;
    const chatId = body.message?.chat?.id?.toString();
    const messageId = body.message?.message_id;

    if (!text || !chatId) return NextResponse.json({ success: true }); 

    // --- CHECK 1: IS THE USER IN THE MIDDLE OF A CHECKOUT? ---
    const { data: session } = await supabase
      .from('deai_sessions')
      .select('*')
      .eq('chat_id', chatId)
      .eq('status', 'AWAITING_PIN')
      .single();

    // If they have an active session waiting for a PIN, process this text as a PIN attempt
    if (session) {
      const isExpired = new Date(session.expires_at) < new Date();
      
      if (isExpired) {
        // Delete expired session
        await supabase.from('deai_sessions').delete().eq('chat_id', chatId);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "⏳ Your checkout session expired. Please start over." })
        });
        return NextResponse.json({ success: true });
      }

      // Check if it's a 4-digit PIN
      if (/^\d{4}$/.test(text.trim())) {
        
        // 🎯 MAGIC UX: Delete their PIN message from the chat history immediately for security!
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        });

        // TODO: In the future, verify the PIN against the user's real account here.
        
        // Send success receipt
        const receiptMessage = `🎉 **Transaction Successful!**\n\n✅ Sent ₦${session.intent_data.amount_ngn} ${session.intent_data.provider} to ${session.intent_data.destination_account}\n🪙 Paid with: ${session.selected_token}\n\n*Transaction Hash: 0x...*`;
        
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: receiptMessage, parse_mode: 'Markdown' })
        });

        // Clear the session so they can start a new one
        await supabase.from('deai_sessions').delete().eq('chat_id', chatId);
        return NextResponse.json({ success: true });

      } else {
        // Not a 4 digit PIN
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "❌ Invalid format. Please enter your 4-digit PIN." })
        });
        return NextResponse.json({ success: true });
      }
    }

    // --- CHECK 2: NO ACTIVE SESSION? ROUTE TO AI INTENT PARSER ---
    const fallbackModels = ["gemini-2.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"];
    let intentData = null;

    for (const modelName of fallbackModels) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
          You are the core intent routing engine for AbaPay.
          Extract the transaction details and return ONLY a valid JSON object.
          
          {
            "intent": "VEND_AIRTIME" | "VEND_DATA" | "PAY_ELECTRICITY" | "UNKNOWN",
            "provider": "MTN" | "AIRTEL" | "GLO" | "9MOBILE" | "IKEJA_ELECTRIC" | null,
            "amount_ngn": number | null,
            "destination_account": string | null,
            "confidence_score": number
          }
          User Message: "${text}"
        `;

        const result = await model.generateContent(prompt);
        intentData = JSON.parse(result.response.text());
        break; 
      } catch (aiError) {
        if (modelName === fallbackModels[fallbackModels.length - 1]) throw new Error("AI unavailable.");
      }
    }

    if (!intentData || intentData.intent === "UNKNOWN") {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "I couldn't quite understand that. Try saying something like: 'Buy 2k MTN airtime for 08123456789'." })
        });
       return NextResponse.json({ success: true });
    }

    // SAVE TO SUPABASE AS 'AWAITING_TOKEN'
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);

    await supabase.from('deai_sessions').upsert({
      chat_id: chatId,
      platform: 'TELEGRAM',
      intent_data: intentData,
      status: 'AWAITING_TOKEN',
      expires_at: expiresAt.toISOString()
    }, { onConflict: 'chat_id' });

    // Send the human-readable confirmation + the buttons
    const paymentKeyboard = {
      inline_keyboard: [
        [{ text: "🔵 USDC", callback_data: "TOKEN_USDC" }, { text: "🟢 USDT", callback_data: "TOKEN_USDT" }],
        [{ text: "🟡 cUSD (Celo)", callback_data: "TOKEN_cUSD" }]
      ]
    };

    const replyMessage = `🤖 **AbaPay Checkout**\n\nGot it. You want to send **₦${intentData.amount_ngn} ${intentData.provider}** airtime to **${intentData.destination_account}**.\n\nWhich stablecoin would you like to use?`;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: replyMessage, parse_mode: 'Markdown', reply_markup: paymentKeyboard })
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}

export async function GET() {
  return NextResponse.json({ status: "AbaPay DeAI Webhook is ALIVE!" });
}
