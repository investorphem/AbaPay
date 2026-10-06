import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// src/lib/idempotency.ts: a money-moving MCP call runs at most once per key, and what is
// remembered depends on whether the call reached its point of no return (markCommitted).

let db: FakeDb;
vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));

import { runIdempotent, markCommitted, requestHash } from '@/lib/idempotency';

beforeEach(() => {
  db = createFakeDb();
  db.unique.idempotency_keys = ['scope,key'];
});

const ARGS = { service: 'AIRTIME', provider: 'mtn', account_number: '08012345678', amount_ngn: 500, pin: '482915' };

// A fake "payment": counts how often it really runs; commits unless told not to.
function payment(counter: { n: number }, opts: { commit?: boolean; wait?: Promise<void> } = {}) {
  return async () => {
    counter.n++;
    if (opts.wait) await opts.wait;
    if (opts.commit !== false) markCommitted();
    return { content: [{ type: 'text', text: `paid #${counter.n}` }] };
  };
}

describe('runIdempotent', () => {
  it('a repeat with the same key returns the stored result instead of paying again', async () => {
    const c = { n: 0 };
    const a = await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0001', payment(c));
    const b = await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0001', payment(c));
    expect(c.n).toBe(1);
    expect(a.kind).toBe('RAN');
    expect(b.kind).toBe('REPLAY');
    expect((b as { result?: unknown }).result).toEqual((a as { result?: unknown }).result);
  });

  it('the same key with different arguments is refused', async () => {
    const c = { n: 0 };
    await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0002', payment(c));
    const b = await runIdempotent('link:1', 'pay_bill', { ...ARGS, amount_ngn: 5000 }, 'order-0002', payment(c));
    expect(b.kind).toBe('MISMATCH');
    expect(c.n).toBe(1);
  });

  it('two concurrent identical calls run the payment once', async () => {
    const c = { n: 0 };
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const first = runIdempotent('link:1', 'pay_bill', ARGS, 'order-0003', payment(c, { wait }));
    await new Promise((r) => setTimeout(r, 0));
    const second = await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0003', payment(c));
    release();
    expect((await first).kind).toBe('RAN');
    expect(second.kind).toBe('IN_PROGRESS');
    expect(c.n).toBe(1);
  });

  it('a call that stopped before committing (wrong PIN, validation) releases the key', async () => {
    const c = { n: 0 };
    const a = await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0004', payment(c, { commit: false }));
    const b = await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0004', payment(c));
    expect(a.kind).toBe('RAN');
    expect(b.kind).toBe('RAN');
    expect(c.n).toBe(2);
  });

  it('with no key, an identical call shortly after is treated as a retry', async () => {
    const c = { n: 0 };
    await runIdempotent('link:1', 'pay_bill', ARGS, null, payment(c));
    const b = await runIdempotent('link:1', 'pay_bill', ARGS, null, payment(c));
    expect(b.kind).toBe('REPLAY');
    expect(c.n).toBe(1);
  });

  it('an expired key runs again', async () => {
    const c = { n: 0 };
    await runIdempotent('link:1', 'pay_bill', ARGS, null, payment(c));
    db.tables.idempotency_keys[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const b = await runIdempotent('link:1', 'pay_bill', ARGS, null, payment(c));
    expect(b.kind).toBe('RAN');
    expect(c.n).toBe(2);
  });

  it('keys are per credential', async () => {
    const c = { n: 0 };
    await runIdempotent('link:1', 'pay_bill', ARGS, 'order-0005', payment(c));
    await runIdempotent('link:2', 'pay_bill', ARGS, 'order-0005', payment(c));
    expect(c.n).toBe(2);
  });

  it('refuses to run when the key cannot be recorded', async () => {
    db.failNextInsert = 'idempotency_keys';
    const c = { n: 0 };
    await expect(runIdempotent('link:1', 'pay_bill', ARGS, 'order-0006', payment(c))).rejects.toThrow('IDEMPOTENCY_UNAVAILABLE');
    expect(c.n).toBe(0);
  });

  it('the PIN is not part of the request hash', () => {
    expect(requestHash('pay_bill', ARGS)).toBe(requestHash('pay_bill', { ...ARGS, pin: '000000', api_key: 'x' }));
    expect(requestHash('pay_bill', ARGS)).not.toBe(requestHash('pay_bill', { ...ARGS, amount_ngn: 501 }));
  });
});
