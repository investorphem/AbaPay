import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// M6: the fulfilment worker finishes payments the request didn't, exactly once, and parks a job
// for review instead of retrying it forever.

let db: FakeDb;
const executeVend = vi.fn();
const reconcileStuckRow = vi.fn();
const alerts: string[] = [];

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/vend', () => ({ executeVend: (...a: unknown[]) => executeVend(...a) }));
vi.mock('@/lib/reconcileStuck', () => ({ reconcileStuckRow: (...a: unknown[]) => reconcileStuckRow(...a) }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (m: string) => { alerts.push(m); } }));
vi.mock('@/lib/vtpass', () => ({ getHeaders: () => ({}) }));
vi.mock('@/lib/monnifyVend', () => ({ requeryMonnifyTransfer: async () => null }));
// What VTpass /requery says about the request_id: {} = no record (never sent).
let vtpassRecord: Record<string, unknown> = {};
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(vtpassRecord))));

import { runFulfilmentJob, runDueJobs, backoffSeconds } from '@/lib/jobs';

const TX = '0x' + 'b'.repeat(64);
const job = (over: Record<string, unknown> = {}) => ({ id: 'j1', transaction_id: 't1', status: 'running', attempts: 1, max_attempts: 8, ...over });

beforeEach(() => {
  executeVend.mockReset();
  reconcileStuckRow.mockReset();
  alerts.length = 0;
  vtpassRecord = {};
  db = createFakeDb({
    transactions: [{ id: 't1', tx_hash: TX, status: 'PROCESSING', request_id: 'req-1', blockchain: 'CELO', service_id: 'mtn', service_category: 'AIRTIME', amount_usdt: 1, amount_naira: 1340 }],
    fulfilment_jobs: [{ id: 'j1', transaction_id: 't1', status: 'queued', attempts: 0, max_attempts: 3, next_run_at: new Date(0).toISOString() }],
  });
  // JS models of claim_jobs / complete_job / fail_job (migration 034).
  db.rpcHandlers = {
    claim_jobs: () => db.tables.fulfilment_jobs.filter((j) => j.status === 'queued').map((j) => Object.assign(j, { status: 'running', attempts: j.attempts + 1 })).map((j) => ({ ...j })),
    complete_job: ({ p_id }) => { db.tables.fulfilment_jobs.find((j) => j.id === p_id)!.status = 'done'; return null; },
    fail_job: ({ p_id, p_error }) => {
      const j = db.tables.fulfilment_jobs.find((x) => x.id === p_id)!;
      j.status = j.attempts >= j.max_attempts ? 'needs_review' : 'queued';
      j.last_error = p_error;
      return j.status;
    },
  };
});

describe('runFulfilmentJob', () => {
  it('a payment the request already finished: nothing to do', async () => {
    db.tables.transactions[0].status = 'SUCCESS';
    expect((await runFulfilmentJob(job())).outcome).toBe('done');
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('a payment the request died before sending: the worker delivers it once', async () => {
    executeVend.mockResolvedValue({ success: true, status: 'SUCCESS' });
    expect((await runFulfilmentJob(job())).outcome).toBe('done');
    expect(executeVend).toHaveBeenCalledTimes(1);
    expect(reconcileStuckRow).not.toHaveBeenCalled();
  });

  it('unstamped, but VTpass already has the order (sent by older code): requeried, never re-sent', async () => {
    vtpassRecord = { content: { transactions: { status: 'pending' } } };
    reconcileStuckRow.mockResolvedValue('pending');
    expect((await runFulfilmentJob(job())).outcome).toBe('retry');
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('VTpass unreachable while checking: requeried, never re-sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    reconcileStuckRow.mockResolvedValue('pending');
    expect((await runFulfilmentJob(job())).outcome).toBe('retry');
    expect(executeVend).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(vtpassRecord))));
  });

  it('a payment already sent is requeried, never re-sent', async () => {
    db.tables.transactions[0].vend_dispatched_at = new Date().toISOString();
    reconcileStuckRow.mockResolvedValue('pending');
    expect((await runFulfilmentJob(job())).outcome).toBe('retry');
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('the provider has no clear answer: parked for review', async () => {
    db.tables.transactions[0].vend_dispatched_at = new Date().toISOString();
    reconcileStuckRow.mockResolvedValue('alerted');
    expect((await runFulfilmentJob(job())).outcome).toBe('needs_review');
  });

  it('a payment an operator was already alerted about is not touched', async () => {
    db.tables.transactions[0].error_code = 'STUCK_ALERTED';
    expect((await runFulfilmentJob(job())).outcome).toBe('needs_review');
    expect(executeVend).not.toHaveBeenCalled();
  });

  it('a preflight intent is not a proven payment', async () => {
    db.tables.transactions[0].tx_hash = 'preflight_x';
    expect((await runFulfilmentJob(job())).outcome).toBe('done');
  });
});

describe('runDueJobs', () => {
  it('completes a job whose payment is delivered', async () => {
    executeVend.mockResolvedValue({ success: true, status: 'SUCCESS' });
    const r = await runDueJobs();
    expect(r).toMatchObject({ ok: true, claimed: 1, done: 1 });
    expect(db.tables.fulfilment_jobs[0].status).toBe('done');
  });

  it('a job that keeps failing reaches needs_review and alerts once', async () => {
    db.tables.transactions[0].vend_dispatched_at = new Date().toISOString();
    reconcileStuckRow.mockResolvedValue('pending');
    for (let i = 0; i < 3; i++) await runDueJobs();
    expect(db.tables.fulfilment_jobs[0].status).toBe('needs_review');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/NEEDS REVIEW/);
  });

  it('a job whose time budget ran out is handed back, not left locked', async () => {
    executeVend.mockResolvedValue({ success: true, status: 'SUCCESS' });
    const r = await runDueJobs({ budgetMs: -1 });
    expect(r.retried).toBe(1);
    expect(executeVend).not.toHaveBeenCalled();
    expect(db.tables.fulfilment_jobs[0].status).toBe('queued');
  });
});

describe('backoffSeconds', () => {
  it('doubles from 30s and caps at an hour', () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(20)).toBe(3600);
  });
});
