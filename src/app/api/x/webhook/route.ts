import { NextResponse } from 'next/server';
import crypto from 'crypto';

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN as string;
const CORE_ENGINE_URL = `${process.env.NEXT_PUBLIC_SITE_URL}/api/deai/core`;

// X requires a CRC (Challenge-Response Check) to verify your webhook
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const crcToken = searchParams.get('crc_token');

  if (crcToken) {
    const hash = crypto.createHmac('sha256', process.env.X_CONSUMER_SECRET as string)
      .update(crcToken)
      .digest('base64');
    return NextResponse.json({ response_token: `sha256=${hash}` });
  }
  return NextResponse.json({ error: 'No crc_token provided' }, { status: 400 });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Check if this is a valid X Direct Message event
    if (body.direct_message_events) {
      const event = body.direct_message_events[0];
      
      // Ignore messages sent BY the bot itself
      if (event.message_create.sender_id === process.env.X_BOT_ACCOUNT_ID) {
        return NextResponse.json({ success: true });
      }

      const text = event.message_create.message_data.text || "";
      const senderId = event.message_create.sender_id; // The user's X Twitter ID

      if (!text || !senderId) return NextResponse.json({ success: true });

      // Forward to the Universal Core Engine (The Brain)
      const response = await fetch(CORE_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'X',
          platform_id: senderId, // Using their X user ID as the unique ID
          text: text
        })
      });

      const engineData = await response.json();

      // Execute the Brain's instructions and reply via X API (v2)
      if (engineData.action === 'REPLY' || engineData.action === 'SUCCESS_RECEIPT' || engineData.action === 'REQUIRE_TOKEN_SELECTION') {
        await fetch(`https://api.twitter.com/2/dm_conversations/with/${senderId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${X_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: engineData.message
          })
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("X Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}
