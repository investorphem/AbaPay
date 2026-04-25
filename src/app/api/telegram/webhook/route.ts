import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // ==========================================
    // SCENARIO 1: THE USER CLICKED A BUTTON
    // ==========================================
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const selectedToken = body.callback_query.data; // e.g., "TOKEN_USDC"

      // Clean up the token name for the message
      const tokenName = selectedToken.replace("TOKEN_", "");

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ You selected **${tokenName}**.\n\nPlease reply with your 4-digit AbaPay PIN to confirm and execute the transaction.`,
          parse_mode: 'Markdown'
        })
      });

      // We must tell Telegram we received the click, or the button will show a loading spinner forever
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
    const chatId = body.message?.chat?.id;

    if (!text || !chatId) {
      return NextResponse.json({ success: true }); 
    }

    // 1. Pass the text to Gemini for Intent Parsing
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
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
    const intentData = JSON.parse(result.response.text());

    // 2. Build the visual Telegram buttons (Inline Keyboard)
    const paymentKeyboard = {
      inline_keyboard: [
        [
          { text: "🔵 USDC", callback_data: "TOKEN_USDC" },
          { text: "🟢 USDT", callback_data: "TOKEN_USDT" }
        ],
        [
          { text: "🟡 cUSD (Celo)", callback_data: "TOKEN_cUSD" }
        ]
      ]
    };

    // 3. Send the human-readable confirmation + the buttons
    const replyMessage = `🤖 **AbaPay Checkout**\n\nGot it. You want to send **₦${intentData.amount_ngn} ${intentData.provider}** airtime to **${intentData.destination_account}**.\n\nWhich stablecoin would you like to use?`;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyMessage,
        parse_mode: 'Markdown',
        reply_markup: paymentKeyboard // This injects the buttons into the chat
      })
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
