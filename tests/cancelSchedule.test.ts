import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';
import { hashPin } from '@/utils/pinSecurity';

// MCP cancel_schedule: one schedule by id needs no PIN (it is what the in-card Cancel button
// sends); bulk cancels need the PIN; and a call with no selector no longer means "all".

let db: FakeDb;

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {}, sendTelegramToUser: async () => {} }));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));
// Heavy modules cancel_schedule never touches.
vi.mock('@/lib/deai/receiptCard', () => ({ renderReceiptImage: async () => null, renderHistoryStatementImage: async () => null }));
vi.mock('@/lib/deai/relayer', () => ({ getRemainingAllowance: async () => 0, getMaxAgentPayment: async () => 0 }));
vi.mock('@/lib/deai/batch', () => ({ checkAutonomousCapacity: async () => ({}), groupByChainToken: () => [], executeAgentPayment: async () => ({}) }));

import { callTool } from '@/lib/deai/mcpTools';

const WALLET = '0xabc0000000000000000000000000000000000001';
const identity = {
  id: 'link-1', wallet_address: WALLET, approved_token: 'USDC', approved_chain: 'BASE',
  is_active: true, link_verified: true, failed_pin_attempts: 0, locked_until: null, pin_hash: hashPin('482915'),
};

beforeEach(() => {
  db = createFakeDb({
    agent_links: [{ id: 'link-1', wallet_address: WALLET, failed_pin_attempts: 0, locked_until: null }],
    scheduled_bills: [
      { id: 's1', wallet_address: WALLET, provider: 'MTN', service_category: 'AIRTIME', is_active: true },
      { id: 's2', wallet_address: WALLET, provider: 'MTN', service_category: 'DATA', is_active: true },
      { id: 's3', wallet_address: WALLET, provider: 'IKEDC', service_category: 'ELECTRICITY', is_active: true },
    ],
  });
  db.rpcHandlers = {
    pin_attempt_reserve: ({ p_link_id }) => {
      const row = db.tables.agent_links.find((r) => r.id === p_link_id)!;
      row.failed_pin_attempts += 1;
      return [{ allowed: true, attempts: row.failed_pin_attempts, locked_until: null, locked_now: false }];
    },
    pin_attempt_clear: ({ p_link_id }) => { db.tables.agent_links.find((r) => r.id === p_link_id)!.failed_pin_attempts = 0; return null; },
  };
});

const active = () => db.tables.scheduled_bills.filter((s) => s.is_active).map((s) => s.id);
const text = (r: any) => r?.content?.[0]?.text as string;

describe('cancel_schedule', () => {
  it('cancels a single schedule by id without a PIN', async () => {
    const r = await callTool('cancel_schedule', { id: 's1' }, identity as any);
    expect(r?.isError).toBeFalsy();
    expect(active()).toEqual(['s2', 's3']);
  });

  it('refuses a call with no selector instead of cancelling everything', async () => {
    const r = await callTool('cancel_schedule', {}, identity as any);
    expect(r?.isError).toBe(true);
    expect(active()).toEqual(['s1', 's2', 's3']);
  });

  it('requires the PIN to cancel all', async () => {
    const r = await callTool('cancel_schedule', { all: true }, identity as any);
    expect(r?.isError).toBe(true);
    expect(text(r)).toMatch(/PIN/);
    expect(active()).toHaveLength(3);
  });

  it('a wrong PIN cancels nothing and is counted', async () => {
    const r = await callTool('cancel_schedule', { all: true, pin: '000000' }, identity as any);
    expect(r?.isError).toBe(true);
    expect(active()).toHaveLength(3);
    expect(db.tables.agent_links[0].failed_pin_attempts).toBe(1);
  });

  it('all: true with the right PIN cancels every schedule', async () => {
    const r = await callTool('cancel_schedule', { all: true, pin: '482915' }, identity as any);
    expect(r?.isError).toBeFalsy();
    expect(active()).toEqual([]);
  });

  it('provider needs the PIN, and cancels only that provider', async () => {
    expect((await callTool('cancel_schedule', { provider: 'mtn' }, identity as any))?.isError).toBe(true);
    expect(active()).toHaveLength(3);
    await callTool('cancel_schedule', { provider: 'mtn', pin: '482915' }, identity as any);
    expect(active()).toEqual(['s3']);
  });
});
