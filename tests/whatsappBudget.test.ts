import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ WHATSAPP COST CONTROLS (src/lib/whatsappBudget.ts). Bounded spend: a per-user daily cap
// with one explanation then silence, never cutting off a payment mid-PIN, a tighter cap once the
// month's free allowance is gone, and an operator alert before the bill starts.

let db: FakeDb;
const alerts: string[] = [];
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (m: string) => { alerts.push(m); } }));

process.env.WHATSAPP_DAILY_USER_CAP = '3';
process.env.WHATSAPP_DAILY_USER_CAP_PAID = '1';
process.env.WHATSAPP_FREE_MONTHLY_REPLIES = '5';
process.env.WHATSAPP_MONTHLY_ALERT_AT = '4';

const { checkDailyCap, countWhatsAppSend, monthUsedSoFar } = await import('@/lib/whatsappBudget');

const NOW = new Date('2026-10-16T10:00:00Z');
beforeEach(() => { db = createFakeDb({ rate_limits: [] }); alerts.length = 0; });

describe('checkDailyCap', () => {
  it('allows up to the cap, then one notice, then silence', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkDailyCap('234800', false, NOW));
    expect(results.slice(0, 3)).toEqual([{ allow: true }, { allow: true }, { allow: true }]);
    expect(results[3]).toEqual({ allow: false, notify: true });
    expect(results.slice(4)).toEqual([{ allow: false, notify: false }, { allow: false, notify: false }]);
  });

  it('never stops a chat that is waiting for its PIN', async () => {
    for (let i = 0; i < 5; i++) await checkDailyCap('234800', false, NOW);
    expect(await checkDailyCap('234800', true, NOW)).toEqual({ allow: true });
  });

  it('counts each user separately, and starts again the next day', async () => {
    for (let i = 0; i < 4; i++) await checkDailyCap('234800', false, NOW);
    expect(await checkDailyCap('234899', false, NOW)).toEqual({ allow: true });
    expect(await checkDailyCap('234800', false, new Date('2026-10-17T10:00:00Z'))).toEqual({ allow: true });
  });

  it('tightens to the paid cap once the free allowance is used up', async () => {
    for (let i = 0; i < 6; i++) await countWhatsAppSend(NOW);
    expect(await checkDailyCap('234800', false, NOW)).toEqual({ allow: true });
    expect(await checkDailyCap('234800', false, NOW)).toMatchObject({ allow: false });
  });
});

describe('countWhatsAppSend', () => {
  it('counts the month and alerts once near the allowance and once past it', async () => {
    for (let i = 0; i < 8; i++) await countWhatsAppSend(NOW);
    expect(await monthUsedSoFar(NOW)).toBe(8);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatch(/4 replies this month/);
    expect(alerts[1]).toMatch(/free allowance used up/);
  });
});
