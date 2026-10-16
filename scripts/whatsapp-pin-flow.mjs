#!/usr/bin/env node
// 🔐 CREATE AND PUBLISH THE WHATSAPP SECURE-PIN FLOW (src/lib/whatsappPinFlow.ts).
//
// Reads the Flow definition from src/config/whatsapp-pin-flow.json and creates it on the
// WhatsApp Business Account through Meta's Graph API. Prints the Flow id; set it as
// WHATSAPP_PIN_FLOW_ID in Vercel and the bot starts sending the "Enter PIN" button.
//
//   node scripts/whatsapp-pin-flow.mjs            create as a DRAFT (testable with
//                                                 WHATSAPP_PIN_FLOW_MODE=draft, not public yet)
//   node scripts/whatsapp-pin-flow.mjs --publish  create and publish (final; published Flows
//                                                 can't be edited, only replaced by a new one)
//
// Needs WHATSAPP_ACCESS_TOKEN (with whatsapp_business_management) and WHATSAPP_BUSINESS_ACCOUNT_ID
// (the WABA id from WhatsApp Manager, not the phone number id), from the environment or .env.local.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve('.env.local'), quiet: true });

const token = process.env.WHATSAPP_ACCESS_TOKEN;
const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
if (!token || !waba) {
  console.error('Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID first.');
  process.exit(1);
}

const publish = process.argv.includes('--publish');
const flowJson = fs.readFileSync(path.resolve('src/config/whatsapp-pin-flow.json'), 'utf8');

const res = await fetch(`https://graph.facebook.com/v21.0/${waba}/flows`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `AbaPay secure PIN${publish ? '' : ' (draft)'}`,
    categories: ['OTHER'],
    flow_json: flowJson,
    publish,
  }),
});
const body = await res.json();
if (!res.ok || !body.id) {
  console.error('Meta refused the Flow:', JSON.stringify(body, null, 2));
  process.exit(1);
}
if (body.validation_errors?.length) {
  console.error('Created, but with validation errors (fix them before publishing):', JSON.stringify(body.validation_errors, null, 2));
}
console.log(`Flow id: ${body.id}${publish ? ' (published)' : ' (draft)'}`);
console.log(`Set WHATSAPP_PIN_FLOW_ID=${body.id}${publish ? '' : ' and WHATSAPP_PIN_FLOW_MODE=draft to test it'}.`);
