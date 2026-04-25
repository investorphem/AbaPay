// src/app/api/telegram/webhook/route.ts
import { NextResponse } from 'next/server';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

export async function POST(req: Request) {
  try {
    // Dynamically grab your live domain (works on localhost AND Vercel automatically)
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const CORE_ENGINE_URL = `${protocol}://${host}/api/deai/core`;

    const body = await req.json();
    const text = body.message?.text || "";
    const chatId = body.message?.chat?.id?.toString();
    const messageId = body.message?.message_id;

    if (!text || !chatId) return NextResponse.json({ success: true });

    // Delete PIN instantly for security (if it looks like a 4 digit number)
    if (/^\d{4}$/.test(text.trim())) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      });
    }

    // Forward to the Universal Core Engine
    const response = await fetch(CORE_ENGINE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'TELEGRAM',
        platform_id: chatId,
        text: text
      })
    });

    const engineData = await response.json();

    // Execute the Brain's instructions
    if (engineData.action === 'REPLY' || engineData.action === 'SUCCESS_RECEIPT' || engineData.action === 'REQUIRE_TOKEN_SELECTION') {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chat_id: chatId, 
            text: engineData.message, 
            parse_mode: 'Markdown' 
          })
      });
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Telegram Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}
