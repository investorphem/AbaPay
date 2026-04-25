import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 1. Extract the message and chat ID from Telegram's payload
    const text = body.message?.text;
    const chatId = body.message?.chat?.id;

    if (!text || !chatId) {
      return NextResponse.json({ success: true }); // Always return 200 to Telegram so they don't retry
    }

        // 2. Pass the text to Gemini for Intent Parsing
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash", // 🔥 JUST CHANGE THIS ONE LINE
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
    const intentData = result.response.text();

    // 3. Send the parsed JSON back to the user on Telegram
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🤖 **AbaPay DeAI Parsed Intent:**\n\n\`\`\`json\n${intentData}\n\`\`\``,
        parse_mode: 'Markdown'
      })
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}
