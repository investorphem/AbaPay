import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';
import { hashPin, verifyPin } from '@/utils/pinSecurity';

// Attempt accounting for chat/MCP PINs (src/lib/deai/pinSecurity.ts + migration 029). The
// rpc handlers below are a line-for-line JS model of pin_attempt_reserve / pin_attempt_clear;
// each call runs to completion before the next, which is what the row lock gives in Postgres.

let db: FakeDb;
const alerts: string[] = [];
const userMsgs: string[] = [];

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({
  sendTelegramAlert: async (m: string) => { alerts.push(m); },
  sendTelegramToUser: async (_c: string, m: string) => { userMsgs.push(m); },
}));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));

import { checkPinAllowed, recordPinFailure, clearPinFailures } from '@/lib/deai/pinSecurity';

const LADDER = [1, 5, 30, 120, 1440];
const LINK = 'link-1';
const PIN_HASH = hashPin('482915');

function reserve({ p_link_id }: { p_link_id: string }) {
  const row = db.tables.agent_links.find((r) => r.id === p_link_id);
  if (!row) return [{ allowed: false, attempts: 0, locked_until: null, locked_now: false }];
  if (row.locked_until && new Date(String(row.locked_until)).getTime() > Date.now()) {
    return [{ allowed: false, attempts: row.failed_pin_attempts, locked_until: row.locked_until, locked_now: false }];
  }
  const next = Number(row.failed_pin_attempts || 0) + 1;
  let until: string | null = null;
  if (next % 5 === 0) until = new Date(Date.now() + LADDER[Math.min(next / 5, LADDER.length) - 1] * 60_000).toISOString();
  row.failed_pin_attempts = next;
  row.locked_until = until;
  return [{ allowed: true, attempts: next, locked_until: until, locked_now: until !== null }];
}

beforeEach(() => {
  alerts.length = 0;
  userMsgs.length = 0;
  db = createFakeDb({
    agent_links: [{ id: LINK, wallet_address: '0xabc0000000000000000000000000000000000001', failed_pin_attempts: 0, locked_until: null }],
  });
  db.rpcHandlers = {
    pin_attempt_reserve: reserve,
    pin_attempt_clear: ({ p_link_id }) => {
      const row = db.tables.agent_links.find((r) => r.id === p_link_id)!;
      row.failed_pin_attempts = 0;
      row.locked_until = null;
      return null;
    },
  };
});

// One full attempt the way every call site does it: gate, verify, record or clear.
async function attempt(pin: string) {
  const gate = await checkPinAllowed(LINK);
  if (!gate.allowed) return { outcome: 'refused' as const, gate };
  if (!verifyPin(pin, PIN_HASH)) return { outcome: 'wrong' as const, fail: await recordPinFailure(LINK, 'chat-1', 'TELEGRAM', gate) };
  await clearPinFailures(LINK);
  return { outcome: 'ok' as const };
}

describe('PIN attempt accounting', () => {
  it('20 concurrent wrong PINs: only 5 are evaluated, and the identity is locked', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(String(100000 + i))));
    expect(results.filter((r) => r.outcome === 'wrong')).toHaveLength(5);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(15);
    const row = db.tables.agent_links[0];
    expect(row.failed_pin_attempts).toBe(5);
    expect(new Date(String(row.locked_until)).getTime()).toBeGreaterThan(Date.now());
  });

  it('sends the lockout alert exactly once, from the attempt that started it', async () => {
    await Promise.all(Array.from({ length: 8 }, () => attempt('000000')));
    expect(alerts).toHaveLength(1);
    expect(userMsgs).toHaveLength(1);
  });

  it('counts down attempts left and locks on the 5th', async () => {
    const msgs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await attempt('111111');
      msgs.push(r.outcome === 'wrong' ? String(r.fail!.message) : r.outcome);
    }
    expect(msgs[0]).toMatch(/4 attempts left/);
    expect(msgs[3]).toMatch(/1 attempt left/);
    expect(msgs[4]).toMatch(/Locked for 1 minute/);
    expect((await attempt('482915')).outcome).toBe('refused'); // even the right PIN, while locked
  });

  it('escalates the lockout on the next round', async () => {
    const row = db.tables.agent_links[0];
    row.failed_pin_attempts = 9; // one lockout already served
    const r = await attempt('111111');
    expect(r.outcome).toBe('wrong');
    const mins = (new Date(String(row.locked_until)).getTime() - Date.now()) / 60000;
    expect(Math.round(mins)).toBe(5);
  });

  it('a correct PIN clears the counter', async () => {
    await attempt('111111');
    await attempt('222222');
    expect(db.tables.agent_links[0].failed_pin_attempts).toBe(2);
    expect((await attempt('482915')).outcome).toBe('ok');
    expect(db.tables.agent_links[0].failed_pin_attempts).toBe(0);
  });

  it('a correct PIN on the locking attempt still succeeds and lifts the lock', async () => {
    db.tables.agent_links[0].failed_pin_attempts = 4;
    expect((await attempt('482915')).outcome).toBe('ok');
    expect(db.tables.agent_links[0].locked_until).toBeNull();
  });

  it('fails closed when the counter is unavailable', async () => {
    db.rpcHandlers = {}; // the function is missing / the DB is unreachable
    const gate = await checkPinAllowed(LINK);
    expect(gate.allowed).toBe(false);
    expect(gate.unavailable).toBe(true);
  });

  it('refuses an identity it cannot find rather than handing out an uncounted guess', async () => {
    const gate = await checkPinAllowed('no-such-link');
    expect(gate.allowed).toBe(false);
  });
});
