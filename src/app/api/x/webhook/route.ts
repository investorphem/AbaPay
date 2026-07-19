// src/app/api/x/webhook/route.ts
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { internalAuthHeaders } from '@/utils/internalAuth';

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN as string;

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
    // Dynamically route to the Brain
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const CORE_ENGINE_URL = `${protocol}://${host}/api/deai/core`;

    // 🔐 PAYLOAD SIGNATURE VERIFICATION (enforced when X_CONSUMER_SECRET is configured)
    // X signs webhook deliveries with HMAC-SHA256 of the raw body using the consumer
    // secret, sent as `x-twitter-webhooks-signature: sha256=<base64>`. Without this,
    // anyone can POST fake DM events impersonating ANY X user id.
    const rawBody = await req.text();
    const consumerSecret = process.env.X_CONSUMER_SECRET;
    if (consumerSecret) {
      const providedSig = req.headers.get('x-twitter-webhooks-signature') || '';
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', consumerSecret).update(rawBody).digest('base64');
      const a = Buffer.from(providedSig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.error('[SECURITY] X webhook: invalid x-twitter-webhooks-signature — rejecting.');
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }

    const body = JSON.parse(rawBody);

    if (body.direct_message_events) {
      const event = body.direct_message_events[0];
      
      if (event.message_create.sender_id === process.env.X_BOT_ACCOUNT_ID) {
        return NextResponse.json({ success: true });
      }

      const text = event.message_create.message_data.text || "";
      const senderId = event.message_create.sender_id;

      if (!text || !senderId) return NextResponse.json({ success: true });

      const response = await fetch(CORE_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalAuthHeaders() },
        body: JSON.stringify({
          platform: 'X',
          platform_id: senderId,
          text: text
        })
      });

      const engineData = await response.json();

      if (engineData.action === 'REPLY' || engineData.action === 'SUCCESS_RECEIPT' || engineData.action === 'REQUIRE_TOKEN_SELECTION') {
        // ⚡ Like WhatsApp — X's API gives a business no reliable way to delete a message the
        // USER sent, so a PIN they typed stays in the DM thread. Telegram auto-deletes it
        // (see the telegram webhook); here we can only advise them to remove it themselves.
        let outgoingMessage = engineData.message as string;
        if (/^\d{4,6}$/.test(text.trim())) {
          outgoingMessage += '\n\n🔒 For your security, please delete your last message (your PIN) from this chat.';
        }

        await fetch(`https://api.twitter.com/2/dm_conversations/with/${senderId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${X_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: outgoingMessage
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
