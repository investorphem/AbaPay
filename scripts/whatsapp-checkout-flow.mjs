#!/usr/bin/env node
// 🛒 SET UP THE WHATSAPP CHECKOUT FLOW (src/lib/whatsappCheckout.ts).
//
//   node scripts/whatsapp-checkout-flow.mjs keys <dir>
//       Generates the RSA-2048 key pair the Flow's data endpoint needs, into <dir>
//       (flow-private.pem, flow-public.pem). The private key is never printed. Put its contents
//       in Vercel as WHATSAPP_FLOW_PRIVATE_KEY (Sensitive), and keep the file somewhere safe or
//       delete it.
//
//   node scripts/whatsapp-checkout-flow.mjs upload-key <dir>/flow-public.pem
//       Registers the public key on the business phone number (needs WHATSAPP_ACCESS_TOKEN and
//       WHATSAPP_PHONE_NUMBER_ID). Same as WhatsApp Manager → Flows → endpoint → "Sign public key".
//
//   node scripts/whatsapp-checkout-flow.mjs create [--publish]
//       Creates the Flow from src/config/whatsapp-checkout-flow.json with its endpoint
//       (https://www.abapays.com/api/whatsapp/flow, or FLOW_ENDPOINT_URI) on the WhatsApp Business
//       Account (needs WHATSAPP_BUSINESS_ACCOUNT_ID). Prints the id for WHATSAPP_CHECKOUT_FLOW_ID.
//       Publish only after the endpoint is deployed with the private key: Meta health-checks it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve('.env.local'), quiet: true });
const [cmd, arg] = process.argv.slice(2);
const token = process.env.WHATSAPP_ACCESS_TOKEN;

async function graph(url, body) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json, null, 2));
  return json;
}

if (cmd === 'keys') {
  const dir = path.resolve(arg || '.');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flow-private.pem'), privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'flow-public.pem'), publicKey);
  console.log(`Wrote ${path.join(dir, 'flow-private.pem')} (secret) and ${path.join(dir, 'flow-public.pem')}.`);
} else if (cmd === 'upload-key') {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId || !arg) { console.error('Needs WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and the public key path.'); process.exit(1); }
  await graph(`${phoneId}/whatsapp_business_encryption`, { business_public_key: fs.readFileSync(arg, 'utf8') });
  console.log('Public key registered.');
} else if (cmd === 'create') {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!token || !waba) { console.error('Needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID.'); process.exit(1); }
  const publish = process.argv.includes('--publish');
  const created = await graph(`${waba}/flows`, {
    name: 'AbaPay checkout',
    categories: ['OTHER'],
    flow_json: fs.readFileSync(path.resolve('src/config/whatsapp-checkout-flow.json'), 'utf8'),
    endpoint_uri: process.env.FLOW_ENDPOINT_URI || 'https://www.abapays.com/api/whatsapp/flow',
    publish,
  });
  if (created.validation_errors?.length) console.error('Validation errors:', JSON.stringify(created.validation_errors, null, 2));
  console.log(`Flow id: ${created.id}${publish ? ' (published)' : ' (draft — test with WHATSAPP_CHECKOUT_FLOW_MODE=draft)'}`);
} else {
  console.log('Usage: keys <dir> | upload-key <public.pem> | create [--publish]');
}
