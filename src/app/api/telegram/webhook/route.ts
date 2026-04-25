import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // ==========================================
    // SCENARIO 1: THE USER CLICKED A PAYMENT BUTTON
    // ==========================================
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const selectedToken = body.callback_query.data; // e.g., "TOKEN_USDC"

      // Clean up the token name for the message
      const tokenName = selectedToken.replace("TOKEN_", "");

      // Send the PIN request message
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ You selected **${tokenName}**.\n\nPlease reply with your 4-digit AbaPay PIN to confirm and execute the transaction.`,
          parse_mode: 'Markdown'
        })
      });

      // Answer the callback to stop the loading spinner on the button
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

    // If there's no text (like a sticker or photo), just ignore it gracefully
    if (!text || !chatId) {
      return NextResponse.json({ success: true }); 
    }

    // 1. Pass the text to Gemini for Intent Parsing with a Fallback Array
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
        
        // If successful, break out of the loop so we don't try the other models
        break; 

      } catch (aiError: any) {
        console.warn(`⚠️ Model ${modelName} failed:`, aiError.message);
        // If it's the last model in the array and it STILL fails, we throw the error
        if (modelName === fallbackModels[fallbackModels.length - 1]) {
          throw new Error("All AI fallback models are currently unavailable.");
        }
      }
    }

    // Safety check just in case the parsing completely failed
    if (!intentData) {
       return NextResponse.json({ success: false, message: "AI Parsing failed" });
    }

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
        reply_markup: paymentKeyboard 
      })
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Webhook Error:", error);
    // Alert the user if everything fails
    if (req.body) {
         // Silently fail for Telegram, but log it
         return NextResponse.json({ success: false });
    }
    return NextResponse.json({ success: false });
  }
}

// Simple pulse check to verify the endpoint is alive in your browser
export async function GET() {
  return NextResponse.json({ status: "AbaPay DeAI Webhook is ALIVE!" });
}
