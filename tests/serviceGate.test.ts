import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// ⚡ THE WEB RAILS' SERVICE GATE + THE PROVIDER BREAKER (implementation plan M3.1 / M3.2).
//
// Real src/lib/serviceRules.ts and src/lib/circuitBreaker.ts against an in-memory
// platform_settings row. Switch keys are exactly the ones the admin dashboard writes and
// page.tsx reads (AIRTIME_mtn, INTERNET_mtn-data, ELEC_ikeja-electric, BANK, MASTER_*).

vi.mock('server-only', () => ({}));

let db: FakeDb;
let liveLimits: { min: number | null; max: number | null } = { min: null, max: null };
const probe = vi.fn<(provider: string) => Promise<void>>(async () => {});
const sendTelegramAlert = vi.fn<(text: string) => Promise<void>>(async () => {});

vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: (t: string) => sendTelegramAlert(t) }));
vi.mock('@/lib/vtpassCatalog', () => ({ limitsForIntent: async () => liveLimits }));
vi.mock('@/lib/balanceAlerts', () => ({ probeCircuitRecovery: (p: string) => probe(p) }));

const { checkWebPayment, checkServiceAllowed } = await import('@/lib/serviceRules');
const { tripCircuit, resetCircuit, isCircuitOpen } = await import('@/lib/circuitBreaker');

// Both modules cache settings briefly; every new settings() moves the clock past those caches.
let clock = Date.parse('2026-09-29T12:00:00Z');
function settings(kill_switches: Record<string, boolean> = {}, provider_circuits: Record<string, unknown> = {}) {
  clock += 120_000;
  vi.setSystemTime(clock);
  db = createFakeDb();
  db.tables.platform_settings = [{ id: 1, exchange_rate: 1340, kill_switches, provider_circuits }];
  // The real function (migration 028): merge one provider's state, report whether it changed.
  db.rpcHandlers = {
    set_provider_circuit: ({ p_provider, p_open, p_reason }: { p_provider: string; p_open: boolean; p_reason: string }, d: FakeDb) => {
      const row = d.tables.platform_settings[0];
      const was = (row.provider_circuits as Record<string, { open?: boolean }> | undefined)?.[p_provider]?.open === true;
      if (was === p_open) return false;
      row.provider_circuits = { ...(row.provider_circuits || {}), [p_provider]: { open: p_open, since: new Date().toISOString(), reason: p_reason } };
      return true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  liveLimits = { min: null, max: null };
  probe.mockClear();
  sendTelegramAlert.mockClear();
  settings();
});

const pay = (serviceCategory: string, serviceID: string, amountNgn = 1000, isFixedPlan = false) =>
  checkWebPayment({ serviceCategory, serviceID, amountNgn, isFixedPlan });

describe('checkWebPayment — kill switches', () => {
  it('allows everything when no switch is set', async () => {
    expect((await pay('AIRTIME', 'mtn')).allowed).toBe(true);
    expect((await pay('ELECTRICITY', 'ikeja-electric')).allowed).toBe(true);
  });

  it('honours the master and per-provider switches, keyed exactly as the dashboard writes them', async () => {
    settings({ AIRTIME_mtn: false });
    expect(await pay('AIRTIME', 'mtn')).toMatchObject({ allowed: false, code: 'SERVICE_UNAVAILABLE' });
    expect((await pay('AIRTIME', 'glo')).allowed).toBe(true);

    settings({ MASTER_AIRTIME: false });
    expect((await pay('AIRTIME', 'glo')).allowed).toBe(false);

    settings({ 'INTERNET_mtn-data': false, 'ELEC_ikeja-electric': false, BANK: false, 'CABLE_dstv': false });
    expect((await pay('INTERNET', 'mtn-data', 500, true)).allowed).toBe(false);
    expect((await pay('ELECTRICITY', 'ikeja-electric')).allowed).toBe(false);
    expect((await pay('BANK', 'moniepoint-transfer')).allowed).toBe(false);
    expect((await pay('CABLE', 'dstv', 5000, true)).allowed).toBe(false);
  });

  it('treats international as OFF unless its switch exists and is not false — like page.tsx', async () => {
    expect((await pay('INTL MOBILE TOP UP', 'foreign-airtime')).allowed).toBe(false);
    settings({ MASTER_INTERNATIONAL: false });
    expect((await pay('INTERNATIONAL', 'foreign-airtime')).allowed).toBe(false);
    settings({ MASTER_INTERNATIONAL: true });
    expect((await pay('INTL DATA', 'foreign-airtime')).allowed).toBe(true);
  });

  it('refuses an unknown category rather than guessing', async () => {
    expect(await pay('LOTTERY', 'x')).toMatchObject({ allowed: false, code: 'UNKNOWN_SERVICE' });
  });
});

describe('checkWebPayment — amounts', () => {
  it('enforces VTpass\'s live per-provider limits', async () => {
    liveLimits = { min: 100, max: 50_000 };
    expect(await pay('AIRTIME', 'airtel', 60_000)).toMatchObject({ allowed: false, code: 'AMOUNT_OUT_OF_RANGE' });
    expect(await pay('AIRTIME', 'airtel', 50)).toMatchObject({ allowed: false, code: 'AMOUNT_OUT_OF_RANGE' });
    expect((await pay('AIRTIME', 'airtel', 20_000)).allowed).toBe(true);
  });

  it('does NOT apply the agent\'s flat ₦500k ceiling to the web app', async () => {
    // No live ceiling published: a ₦1,000,000 electricity payment the web form allows passes.
    expect((await pay('ELECTRICITY', 'phed-electric', 1_000_000)).allowed).toBe(true);
  });

  it('skips the range check for a fixed-price plan', async () => {
    liveLimits = { min: 1000, max: 2000 };
    expect((await pay('INTERNET', 'mtn-data', 50, true)).allowed).toBe(true);
  });
});

describe('provider circuit breaker', () => {
  it('trips once, alerts once, and refuses VTpass services on every rail — but not bank transfers', async () => {
    await tripCircuit('VTPASS', 'VTpass answered 018');
    await tripCircuit('VTPASS', 'VTpass answered 018 again');
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(await isCircuitOpen('VTPASS')).toBe(true);

    expect(await pay('AIRTIME', 'mtn')).toMatchObject({ allowed: false, code: 'SERVICE_UNAVAILABLE' });
    expect((await checkServiceAllowed('VEND_AIRTIME', 'mtn')).allowed).toBe(false); // chat / MCP / scheduler
    expect((await pay('BANK', 'moniepoint-transfer')).allowed).toBe(true);           // Monnify, not VTpass
  });

  it('gives an open breaker one recovery probe before refusing', async () => {
    settings({}, { VTPASS: { open: true } });
    probe.mockImplementationOnce(async () => { await resetCircuit('VTPASS', 'balance restored'); });
    expect((await pay('AIRTIME', 'mtn')).allowed).toBe(true);
    expect(probe).toHaveBeenCalledWith('VTPASS');
  });

  it('never touches kill_switches, so an operator\'s own switch survives a reset', async () => {
    settings({ MASTER_ELECTRICITY: false }, { VTPASS: { open: true } });
    await resetCircuit('VTPASS', 'balance restored');
    expect(db.tables.platform_settings[0].kill_switches).toEqual({ MASTER_ELECTRICITY: false });
    expect((await pay('ELECTRICITY', 'ikeja-electric')).allowed).toBe(false);
  });

  it('can be disabled entirely by env', async () => {
    settings({}, { VTPASS: { open: true } });
    process.env.CIRCUIT_BREAKER_ENABLED = 'false';
    try {
      expect((await pay('AIRTIME', 'mtn')).allowed).toBe(true);
    } finally {
      delete process.env.CIRCUIT_BREAKER_ENABLED;
    }
  });
});
