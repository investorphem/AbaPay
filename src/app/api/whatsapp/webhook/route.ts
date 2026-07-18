// src/app/api/whatsapp/webhook/route.ts
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { internalAuthHeaders } from '@/utils/internalAuth';

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
    // ⚡ THESE TWO FAILING SILENTLY IS EXACTLY WHY "sent the code, nothing happened" is so
    // hard to diagnose from the outside — `as string` is just a TypeScript assertion, not a
    // runtime check, so a missing/expired token or wrong phone ID previously meant every
    // outbound send below just quietly 400/401'd with nothing logged anywhere.
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
      console.error('[WhatsApp] WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not configured — cannot send replies.');
    }

    // Dynamically route to the Brain
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const CORE_ENGINE_URL = `${protocol}://${host}/api/deai/core`;

    // 🔐 PAYLOAD SIGNATURE VERIFICATION (enforced when WHATSAPP_APP_SECRET is configured)
    // Meta signs every webhook delivery with HMAC-SHA256 of the raw body using your
    // App Secret, sent as `X-Hub-Signature-256: sha256=<hex>`. Without verifying it,
    // anyone on the internet can POST a fake "message" impersonating ANY sender
    // number and interact with that user's DeAI identity.
    const rawBody = await req.text();
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret) {
      const providedSig = req.headers.get('x-hub-signature-256') || '';
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const a = Buffer.from(providedSig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.error('[SECURITY] WhatsApp webhook: invalid X-Hub-Signature-256 — rejecting.');
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }

    const body = JSON.parse(rawBody);

    if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const messageObj = body.entry[0].changes[0].value.messages[0];
      
      const text = messageObj.text?.body || "";
      const senderNumber = messageObj.from;

      if (!text || !senderNumber) return NextResponse.json({ success: true });

      const response = await fetch(CORE_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalAuthHeaders() },
        body: JSON.stringify({
          platform: 'WHATSAPP',
          platform_id: senderNumber,
          text: text
        })
      });

      const engineData = await response.json();

      // ⚡ The core engine can reject a request (bad internal-auth secret, malformed payload)
      // and respond with a 4xx + an `error` field instead of `action` — previously that meant
      // silently doing nothing. Log it so a misconfigured DEAI_INTERNAL_SECRET is visible
      // instead of looking identical to "the send just didn't work."
      if (!response.ok) {
        console.error('[WhatsApp] Core engine rejected the request:', response.status, JSON.stringify(engineData));
      }

      if (engineData.action === 'REPLY' || engineData.action === 'SUCCESS_RECEIPT' || engineData.action === 'REQUIRE_TOKEN_SELECTION') {
        const sendRes = await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
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

        // ⚡ THE ACTUAL FIX — this call's result was never checked. A bad/expired access
        // token or wrong phone number ID makes Meta's Graph API return a 4xx with a detailed
        // error body (e.g. "Invalid OAuth access token", "(#100) phone number ... does not
        // exist") — none of that ever reached the logs before, so the send just silently
        // failed with zero trace anywhere.
        if (!sendRes.ok) {
          const errBody = await sendRes.text();
          console.error('[WhatsApp] Failed to send reply via Graph API:', sendRes.status, errBody);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("WhatsApp Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}
