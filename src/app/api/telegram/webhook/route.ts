import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

// 1. Initialize Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

// Initialize Supabase (Uses Service Role Key to safely bypass RLS on the server)
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

      // 3. Answer the callback to stop the loading spinner
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
    const text = body.message?.text || "";
    const chatId = body.message?.chat?.id?.toString();
    const messageId = body.message?.message_id;

    if (!text || !chatId) return NextResponse.json({ success: true }); 

    // --- GATEWAY 1: ACCOUNT LINKING VIA DEEP LINK ---
    // If the user clicks a link like t.me/AbaPayBot?start=auth_12345
    if (text.startsWith('/start auth_')) {
      const authToken = text.split(' ')[1]; // Extracts the token

      // Find the user with this token and save their chat ID
      const { data: updatedUser, error } = await supabase
        .from('users') // **CHANGE THIS if your table is named differently**
        .update({ telegram_chat_id: chatId })
        .eq('telegram_auth_token', authToken)
        .select()
        .single();

      if (updatedUser) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chat_id: chatId, 
            text: "✅ **Account Linked Successfully!**\n\nI am connected to your AbaPay wallet. What bill can I sort out for you today?",
            parse_mode: 'Markdown'
          })
        });
      } else {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: "❌ Invalid or expired linking token. Please try again from the web dashboard." })
        });
      }
      return NextResponse.json({ success: true });
    }

    // --- GATEWAY 2: THE BOUNCER (Is this an existing user?) ---
    const { data: registeredUser } = await supabase
      .from('users') // **CHANGE THIS if your table is named differently**
      .select('id, pin') // Fetch their ID and PIN
      .eq('telegram_chat_id', chatId)
      .single();

    if (!registeredUser) {
      // Reject unauthorized users immediately
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chat_id: chatId, 
            text: "🔒 **Unauthorized**\n\nPlease link your AbaPay account first by logging into the web dashboard and clicking 'Connect Telegram'." 
          })
      });
      return NextResponse.json({ success: true });
    }


    // --- GATEWAY 3: PIN CHECKOUT PHASE ---
    const { data: session } = await supabase
      .from('deai_sessions')
      .select('*')
      .eq('chat_id', chatId)
      .eq('status', 'AWAITING_PIN')
      .single();

    if (session) {
      const isExpired = new Date(session.expires_at) < new Date();
      
      if (isExpired) {
        await supabase.from('deai_sessions').delete().eq('chat_id', chatId);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "⏳ Your checkout session expired. Please start over." })
        });
        return NextResponse.json({ success: true });
      }

      // 🎯 MAGIC UX: Delete their PIN message instantly for security!
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      });

      // Verify the PIN against the user's actual saved PIN in the database
      if (text.trim() === registeredUser.pin) {
        
        // --- 🚀 BLOCKCHAIN & VTPASS LOGIC GOES HERE ---
        // 1. Trigger smart contract using registeredUser.id
        // 2. Call VTPass API using session.intent_data
        
        // Send success receipt
        const receiptMessage = `🎉 **Transaction Successful!**\n\n✅ Sent ₦${session.intent_data.amount_ngn} ${session.intent_data.provider} to ${session.intent_data.destination_account}\n🪙 Paid with: ${session.selected_token}\n\n*Transaction Hash: 0x...*`;
        
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: receiptMessage, parse_mode: 'Markdown' })
        });

        // Clear the session
        await supabase.from('deai_sessions').delete().eq('chat_id', chatId);
        return NextResponse.json({ success: true });

      } else {
        // Wrong PIN
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "❌ Incorrect PIN. Please try again." })
        });
        return NextResponse.json({ success: true });
      }
    }


    // --- GATEWAY 4: AI INTENT PARSER (Standard text requests) ---
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
