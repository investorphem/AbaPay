import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendWhatsAppMessage, isOutOfWindowError, toTemplateParameter } from '@/lib/whatsapp';

/**
 * 🔴 THE 24-HOUR CUSTOMER SERVICE WINDOW. A business may only send free-form text within 24h
 * of the user's last message; outside it Meta rejects with 131047 and only a pre-approved
 * template gets through. Business Verification does NOT lift this — it governs how many people
 * you may message outside a window, not what you may send them.
 *
 * The scheduler is the caller this bites: a payment scheduled for tomorrow reports back long
 * after the chat that created it went quiet, so the "your electricity bill was paid" message
 * was rejected every time — and swallowed, so the only symptom was a user who never heard back.
 */

const OUT_OF_WINDOW = JSON.stringify({
  error: { message: 'Re-engagement message', code: 131047, type: 'OAuthException' },
});
const EXPIRED_TOKEN = JSON.stringify({
  error: { message: 'Invalid OAuth access token', code: 190, type: 'OAuthException' },
});

/** Queue of responses, one per fetch call, so a text→template retry can be asserted in order. */
function mockGraph(responses: Array<{ ok: boolean; body?: string }>) {
  const calls: any[] = [];
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const next = responses.shift() ?? { ok: true };
    return {
      ok: next.ok,
      text: async () => next.body ?? '',
    } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('sendWhatsAppMessage', () => {
  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
    delete process.env.WHATSAPP_SCHEDULE_TEMPLATE_NAME;
    delete process.env.WHATSAPP_SCHEDULE_TEMPLATE_LANG;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends plain text and stops there while the window is open', async () => {
    const calls = mockGraph([{ ok: true }]);
    expect(await sendWhatsAppMessage('2348000000000', 'Paid ✅')).toBe(true);
    expect(calls).toHaveLength(1); // no needless template send — text is free
    expect(calls[0].type).toBe('text');
  });

  // 🔴 The actual fix.
  it('falls back to the template when the 24h window has closed', async () => {
    process.env.WHATSAPP_SCHEDULE_TEMPLATE_NAME = 'schedule_update';
    const calls = mockGraph([{ ok: false, body: OUT_OF_WINDOW }, { ok: true }]);

    expect(await sendWhatsAppMessage('2348000000000', 'Paid ✅\n\n₦1,000')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].type).toBe('text');
    expect(calls[1].type).toBe('template');
    expect(calls[1].template.name).toBe('schedule_update');
    expect(calls[1].template.language.code).toBe('en');
    expect(calls[1].template.components[0].parameters[0].text).toBe('Paid ✅ — ₦1,000');
  });

  it('honours a configured template language', async () => {
    process.env.WHATSAPP_SCHEDULE_TEMPLATE_NAME = 'schedule_update';
    process.env.WHATSAPP_SCHEDULE_TEMPLATE_LANG = 'en_US';
    const calls = mockGraph([{ ok: false, body: OUT_OF_WINDOW }, { ok: true }]);

    await sendWhatsAppMessage('2348000000000', 'hi');
    expect(calls[1].template.language.code).toBe('en_US');
  });

  // 🔴 Retrying anything else would re-send a message Meta refused for a real reason — an
  // expired token, a blocked recipient — and cost quality rating for nothing.
  it('does NOT retry a failure that is not the window closing', async () => {
    process.env.WHATSAPP_SCHEDULE_TEMPLATE_NAME = 'schedule_update';
    const calls = mockGraph([{ ok: false, body: EXPIRED_TOKEN }]);

    expect(await sendWhatsAppMessage('2348000000000', 'hi')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reports failure loudly when the window is shut and no template is configured', async () => {
    const calls = mockGraph([{ ok: false, body: OUT_OF_WINDOW }]);
    expect(await sendWhatsAppMessage('2348000000000', 'hi')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('WHATSAPP_SCHEDULE_TEMPLATE_NAME'));
  });

  it('reports failure when the template itself is rejected', async () => {
    process.env.WHATSAPP_SCHEDULE_TEMPLATE_NAME = 'not_approved_yet';
    mockGraph([{ ok: false, body: OUT_OF_WINDOW }, { ok: false, body: '{"error":{"code":132001}}' }]);
    expect(await sendWhatsAppMessage('2348000000000', 'hi')).toBe(false);
  });

  it('refuses to send with no credentials rather than throwing', async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    mockGraph([{ ok: true }]);
    expect(await sendWhatsAppMessage('2348000000000', 'hi')).toBe(false);
  });

  it('survives a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await sendWhatsAppMessage('2348000000000', 'hi')).toBe(false);
  });
});

describe('isOutOfWindowError', () => {
  it('recognises 131047, and 470 from older API versions', () => {
    expect(isOutOfWindowError(OUT_OF_WINDOW)).toBe(true);
    expect(isOutOfWindowError('{"error":{"code":470}}')).toBe(true);
  });

  it('does not mistake other failures for a closed window', () => {
    expect(isOutOfWindowError(EXPIRED_TOKEN)).toBe(false);
    expect(isOutOfWindowError('{"error":{"code":131026}}')).toBe(false); // undeliverable ≠ window
    expect(isOutOfWindowError('not json at all')).toBe(false);
    expect(isOutOfWindowError('')).toBe(false);
  });
});

/**
 * 🔴 A TEMPLATE BODY PARAMETER MAY NOT CONTAIN NEWLINES, TABS, OR 4+ CONSECUTIVE SPACES —
 * Meta rejects the whole send. Every message the scheduler builds is multi-line, so passing one
 * through untouched would just swap one rejection for another.
 */
describe('toTemplateParameter', () => {
  it('flattens the multi-line messages the scheduler actually produces', () => {
    const real = '✅ *Paid automatically — MTN*\n\n₦1,000 (0.75 USDC)\n📱 08145043264\n\n_Check History shortly._';
    const out = toTemplateParameter(real);

    expect(out).not.toMatch(/[\n\r\t]/);
    expect(out).not.toMatch(/ {4}/);
    // Paragraph breaks stay readable as separate thoughts rather than one run-on line.
    expect(out).toContain('✅ *Paid automatically — MTN* — ₦1,000 (0.75 USDC) 📱 08145043264');
  });

  it('collapses runs of spaces that would trip the 4-space rule', () => {
    expect(toTemplateParameter('a        b')).toBe('a   b');
  });

  it('truncates at Metas 1024-character parameter cap', () => {
    const out = toTemplateParameter('x'.repeat(2000));
    expect(out).toHaveLength(1024);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty and nullish input without throwing', () => {
    expect(toTemplateParameter('')).toBe('');
    expect(toTemplateParameter(undefined as any)).toBe('');
  });
});
