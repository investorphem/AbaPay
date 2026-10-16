import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ SECURE PIN ENTRY ON WHATSAPP, end to end through the webhook
// (src/app/api/whatsapp/webhook/route.ts + src/lib/whatsappPinFlow.ts).
//   • a chat left waiting for a PIN gets the "Enter PIN" Flow button, not plain text;
//   • a completed form's PIN reaches the engine exactly like a typed PIN, with no "delete your
//     PIN" note (it was never in the chat);
//   • an unreadable form reply is answered without reaching the engine, so it can't count as a
//     wrong PIN.

const SECRET = 'test-app-secret';
let db: FakeDb;
const graphSends: Record<string, unknown>[] = [];
const engineCalls: { text: string }[] = [];
let engineReply: Record<string, unknown> = { action: 'REPLY', message: 'ok' };

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/utils/internalAuth', () => ({ internalAuthHeaders: () => ({}) }));
vi.mock('@/lib/webhookEvents', () => ({ claimWebhookEvent: async () => 'NEW', releaseWebhookEvent: async () => {} }));

vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body || '{}'));
  if (String(url).includes('/api/deai/core')) {
    engineCalls.push(body);
    return new Response(JSON.stringify(engineReply));
  }
  if (String(url).includes('graph.facebook.com')) {
    graphSends.push(body);
    return new Response('{}');
  }
  throw new Error(`unexpected fetch ${url}`);
}));

process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_ACCESS_TOKEN = 'token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111';
process.env.WHATSAPP_DAILY_USER_CAP = '2';

const { POST } = await import('@/app/api/whatsapp/webhook/route');

const SENDER = '2348012345678';
function deliver(message: Record<string, unknown>) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `wamid.${Math.random()}`, from: SENDER, ...message }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return POST(new Request('https://www.abapays.com/api/whatsapp/webhook', { method: 'POST', headers: { 'x-hub-signature-256': sig, host: 'www.abapays.com' }, body: raw }));
}
const flowReply = (data: unknown) => ({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify(data) } } });
const awaitingPin = () => db.tables.deai_sessions.push({ chat_id: SENDER, platform: 'WHATSAPP', status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300_000).toISOString() });

beforeEach(() => {
  db = createFakeDb({ deai_sessions: [] });
  graphSends.length = 0;
  engineCalls.length = 0;
  engineReply = { action: 'REPLY', message: 'Confirm MTN data for 0806… (₦100). Enter your PIN.' };
  process.env.WHATSAPP_PIN_FLOW_ID = '987654321';
});

describe('asking for the PIN', () => {
  it('sends the "Enter PIN" Flow button when the chat is now waiting for a PIN', async () => {
    awaitingPin();
    await deliver({ type: 'text', text: { body: 'yes, confirm' } });
    expect(graphSends[0]).toMatchObject({ type: 'interactive', interactive: { type: 'flow', action: { parameters: { flow_id: '987654321', flow_cta: 'Enter PIN' } } } });
  });

  it('sends plain text when the chat is not waiting for a PIN', async () => {
    await deliver({ type: 'text', text: { body: 'hi' } });
    expect(graphSends[0]).toMatchObject({ type: 'text' });
  });

  it('falls back to plain text when the Flow is not configured', async () => {
    delete process.env.WHATSAPP_PIN_FLOW_ID;
    awaitingPin();
    await deliver({ type: 'text', text: { body: 'yes' } });
    expect(graphSends[0]).toMatchObject({ type: 'text' });
  });
});

describe('receiving the PIN from the form', () => {
  it('passes the PIN to the engine like a typed one, without the "delete your PIN" note', async () => {
    engineReply = { action: 'REPLY', message: 'Payment sent.', isPinEntry: true };
    await deliver(flowReply({ flow_token: 'abapay-pin:abc', pin: '4821' }));
    expect(engineCalls).toEqual([expect.objectContaining({ text: '4821', platform: 'WHATSAPP', platform_id: SENDER })]);
    expect(JSON.stringify(graphSends[0])).not.toMatch(/delete your last message/);
  });

  it('still adds the "delete your PIN" note when a PIN was typed into the chat', async () => {
    engineReply = { action: 'REPLY', message: 'Payment sent.', isPinEntry: true };
    await deliver({ type: 'text', text: { body: '4821' } });
    expect(JSON.stringify(graphSends[0])).toMatch(/delete your last message/);
  });

  it('answers an unreadable form reply itself, so it never counts as a wrong PIN', async () => {
    await deliver(flowReply({ flow_token: 'abapay-pin:abc', pin: '12' }));
    expect(engineCalls).toHaveLength(0);
    expect(graphSends[0]).toMatchObject({ type: 'interactive', interactive: { type: 'flow' } });
  });
});

describe('daily cap (src/lib/whatsappBudget.ts)', () => {
  it('past the cap: one notice, then silence, and the engine is never called', async () => {
    for (let i = 0; i < 5; i++) await deliver({ type: 'text', text: { body: `hi ${i}` } });
    expect(engineCalls).toHaveLength(2);
    const notices = graphSends.filter((m) => JSON.stringify(m).includes("today's WhatsApp chat limit"));
    expect(notices).toHaveLength(1);
    expect(graphSends).toHaveLength(3);
  });

  it('a chat waiting for its PIN still gets through past the cap', async () => {
    for (let i = 0; i < 4; i++) await deliver({ type: 'text', text: { body: 'hi' } });
    awaitingPin();
    engineCalls.length = 0;
    await deliver(flowReply({ flow_token: 'abapay-pin:abc', pin: '4821' }));
    expect(engineCalls).toEqual([expect.objectContaining({ text: '4821' })]);
  });
});
