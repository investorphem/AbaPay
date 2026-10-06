import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// Inbound chat-webhook de-duplication (src/lib/webhookEvents.ts, migration 030) and its use
// in the Telegram webhook: a redelivered update must reach the core engine at most once.

let db: FakeDb;

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/utils/internalAuth', () => ({ internalAuthHeaders: () => ({}) }));

import { claimWebhookEvent, releaseWebhookEvent } from '@/lib/webhookEvents';
import { POST as telegramPOST } from '@/app/api/telegram/webhook/route';

const coreCalls: any[] = [];
let coreFails = false;

beforeEach(() => {
  db = createFakeDb();
  db.unique.webhook_events = ['source,external_id'];
  coreCalls.length = 0;
  coreFails = false;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    if (String(url).includes('/api/deai/core')) {
      if (coreFails) throw new Error('core unreachable');
      coreCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ action: 'REPLY', message: 'ok' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 }); // Telegram Bot API
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function update(updateId: number, text = 'hello') {
  return new Request('https://abapays.com/api/telegram/webhook', {
    method: 'POST',
    headers: { host: 'abapays.com', 'x-telegram-bot-api-secret-token': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: updateId, message: { message_id: 7, text, chat: { id: 42, type: 'private' }, from: { id: 42 } } }),
  });
}

describe('claimWebhookEvent', () => {
  it('claims an id once per source', async () => {
    expect(await claimWebhookEvent('TELEGRAM', 1)).toBe('NEW');
    expect(await claimWebhookEvent('TELEGRAM', 1)).toBe('DUPLICATE');
    expect(await claimWebhookEvent('WHATSAPP', 1)).toBe('NEW');
  });

  it('processes a delivery it cannot track rather than dropping it', async () => {
    db.failNextInsert = 'webhook_events';
    expect(await claimWebhookEvent('TELEGRAM', 2)).toBe('UNTRACKED');
    expect(await claimWebhookEvent('TELEGRAM', undefined)).toBe('UNTRACKED');
  });

  it('a released id can be claimed again', async () => {
    await claimWebhookEvent('X', 'e1');
    await releaseWebhookEvent('X', 'e1');
    expect(await claimWebhookEvent('X', 'e1')).toBe('NEW');
  });
});

describe('Telegram webhook de-duplication', () => {
  it('the same update delivered twice at once reaches the core engine once', async () => {
    const [a, b] = await Promise.all([telegramPOST(update(100, '482915')), telegramPOST(update(100, '482915'))]);
    expect(coreCalls).toHaveLength(1);
    const bodies = await Promise.all([a.json(), b.json()]);
    expect(bodies.filter((x: { duplicate?: boolean }) => x.duplicate)).toHaveLength(1);
  });

  it('different updates are both processed', async () => {
    await telegramPOST(update(101));
    await telegramPOST(update(102));
    expect(coreCalls).toHaveLength(2);
  });

  it('a delivery that failed mid-processing is let through on retry', async () => {
    coreFails = true;
    await telegramPOST(update(103));
    coreFails = false;
    await telegramPOST(update(103));
    expect(coreCalls).toHaveLength(1);
  });
});
