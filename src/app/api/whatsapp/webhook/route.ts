// src/app/api/whatsapp/webhook/route.ts
import { NextResponse } from 'next/server';

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN as string;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID as string;

// Meta requires this GET request to verify your webhook URL initially
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
}

export async function POST(req: Request) {
  try {
    // Dynamically route to the Brain
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const CORE_ENGINE_URL = `${protocol}://${host}/api/deai/core`;

    const body = await req.json();

    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const messageObj = body.entry[0].changes[0].value.messages[0];
      
      const text = messageObj.text?.body || "";
      const senderNumber = messageObj.from;

      if (!text || !senderNumber) return NextResponse.json({ success: true });

      const response = await fetch(CORE_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'WHATSAPP',
          platform_id: senderNumber,
          text: text
        })
      });

      const engineData = await response.json();

      if (engineData.action === 'REPLY' || engineData.action === 'SUCCESS_RECEIPT' || engineData.action === 'REQUIRE_TOKEN_SELECTION') {
        await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: senderNumber,
            type: "text",
            text: { body: engineData.message }
          })
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("WhatsApp Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}
