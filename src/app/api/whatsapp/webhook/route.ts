import { NextResponse } from 'next/server';

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN as string;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID as string;
const CORE_ENGINE_URL = `${process.env.NEXT_PUBLIC_SITE_URL}/api/deai/core`;

// Meta requires this GET request to verify your webhook URL initially
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  // Set your own secret verify token in Vercel (e.g., 'abapay_whatsapp_secret_123')
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Check if this is a valid WhatsApp message payload
    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const messageObj = body.entry[0].changes[0].value.messages[0];
      
      const text = messageObj.text?.body || "";
      const senderNumber = messageObj.from; // The user's phone number

      if (!text || !senderNumber) return NextResponse.json({ success: true });

      // Forward to the Universal Core Engine (The Brain)
      const response = await fetch(CORE_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'WHATSAPP',
          platform_id: senderNumber, // Using their phone number as the unique ID
          text: text
        })
      });

      const engineData = await response.json();

      // Execute the Brain's instructions and reply via WhatsApp Cloud API
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
            text: { body: engineData.message } // WhatsApp doesn't use Markdown quite like Telegram, but standard text works perfectly
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
