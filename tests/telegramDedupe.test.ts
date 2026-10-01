import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// M5: the same alert within 15 minutes is sent once; the next one after the window says how
// many were held back.

vi.mock('server-only', () => ({}));
import { sendTelegramAlert, _resetTelegramDedupe } from '@/lib/telegram';

let sent: string[];
beforeEach(() => {
  _resetTelegramDedupe();
  sent = [];
  process.env.TELEGRAM_BOT_TOKEN = 't';
  process.env.TELEGRAM_ADMIN_CHAT_ID = 'c';
  process.env.NEXT_PUBLIC_APP_MODE = 'live';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).text); return new Response('{"ok":true}'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sendTelegramAlert de-duplication', () => {
  it('sends a repeated alert once within 15 minutes', async () => {
    await sendTelegramAlert('VTpass float low');
    await sendTelegramAlert('VTpass float low');
    await sendTelegramAlert('VTpass float low');
    expect(sent).toHaveLength(1);
  });

  it('after the window, sends again and reports the suppressed count', async () => {
    await sendTelegramAlert('VTpass float low');
    await sendTelegramAlert('VTpass float low');
    await sendTelegramAlert('VTpass float low');
    vi.setSystemTime(new Date('2026-10-01T12:16:00Z'));
    await sendTelegramAlert('VTpass float low');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/2 identical alerts suppressed/);
  });

  it('a shared key groups alerts whose text differs', async () => {
    await sendTelegramAlert('balance 4,000', { key: 'vtpass-float' });
    await sendTelegramAlert('balance 3,500', { key: 'vtpass-float' });
    expect(sent).toHaveLength(1);
  });

  it('different alerts are not held back', async () => {
    await sendTelegramAlert('A');
    await sendTelegramAlert('B');
    expect(sent).toHaveLength(2);
  });
});
