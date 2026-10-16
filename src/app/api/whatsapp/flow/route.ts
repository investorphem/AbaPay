import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { decryptFlowRequest, encryptFlowResponse, FlowDecryptError, type EncryptedFlowRequest } from '@/lib/whatsappFlowCrypto';
import { handleCheckoutRequest, type FlowRequest } from '@/lib/whatsappCheckout';

// ⚡ WHATSAPP FLOWS DATA ENDPOINT — answers the checkout form's screens (src/lib/whatsappCheckout.ts).
//
// WhatsApp calls this while the user fills the form: a health-check ping, then one request per
// screen. These calls are NOT messages, so Meta doesn't bill them. Each request is
//   1. signed with our app secret (X-Hub-Signature-256), checked first, fail closed;
//   2. encrypted to our public key — decrypted with WHATSAPP_FLOW_PRIVATE_KEY (PEM), and a
//      request we can't decrypt gets 421 so WhatsApp re-fetches the key;
// and the answer goes back encrypted, as plain text (src/lib/whatsappFlowCrypto.ts).

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const raw = await req.text();

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const privateKey = process.env.WHATSAPP_FLOW_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appSecret || !privateKey) {
    console.error('[WhatsApp Flow] WHATSAPP_APP_SECRET or WHATSAPP_FLOW_PRIVATE_KEY is not configured.');
    return NextResponse.json({ error: 'Flow endpoint not configured' }, { status: 503 });
  }

  const provided = Buffer.from(req.headers.get('x-hub-signature-256') || '');
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex'));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 432 });
  }

  let decrypted;
  try {
    decrypted = decryptFlowRequest(JSON.parse(raw) as EncryptedFlowRequest, privateKey, process.env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE || undefined);
  } catch (err) {
    if (err instanceof FlowDecryptError || err instanceof SyntaxError) return new NextResponse(null, { status: 421 });
    throw err;
  }

  let response;
  try {
    response = await handleCheckoutRequest(decrypted.request as FlowRequest);
  } catch (err) {
    console.error('[WhatsApp Flow] handler failed:', err);
    response = { screen: 'SERVICE', data: { error_message: 'Something went wrong. Please try again.', has_error: true } };
  }

  return new NextResponse(encryptFlowResponse(response, decrypted.aesKey, decrypted.iv), {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
