import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pingDeadman, withDeadman } from '@/lib/deadman';

// M5: each cron pings its monitor on success and `/fail` on failure; with no URL it sends nothing.

let calls: string[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response('OK', { status: 200 }); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ['HEALTHCHECK_URL_CLEANUP', 'HEALTHCHECK_URL_DUNE', 'HEALTHCHECK_URL_DUNE_BASE']) delete process.env[k];
});

describe('dead-man pings', () => {
  it('pings the job URL on success', async () => {
    process.env.HEALTHCHECK_URL_CLEANUP = 'https://hc-ping.com/abc';
    await pingDeadman('CLEANUP', true);
    expect(calls).toEqual(['https://hc-ping.com/abc']);
  });

  it('pings /fail when the run failed', async () => {
    process.env.HEALTHCHECK_URL_CLEANUP = 'https://hc-ping.com/abc/';
    await pingDeadman('CLEANUP', false);
    expect(calls).toEqual(['https://hc-ping.com/abc/fail']);
  });

  it('sends nothing when no URL is configured', async () => {
    await pingDeadman('CLEANUP', true);
    expect(calls).toEqual([]);
  });

  it('falls back to the shared job URL', async () => {
    process.env.HEALTHCHECK_URL_DUNE = 'https://hc-ping.com/dune';
    await pingDeadman('DUNE_BASE', true, 'DUNE');
    expect(calls).toEqual(['https://hc-ping.com/dune']);
  });

  it('withDeadman pings /fail and rethrows when the job throws', async () => {
    process.env.HEALTHCHECK_URL_CLEANUP = 'https://hc-ping.com/abc';
    await expect(withDeadman('CLEANUP', () => true, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls).toEqual(['https://hc-ping.com/abc/fail']);
  });

  it('a monitor outage never breaks the job', async () => {
    process.env.HEALTHCHECK_URL_CLEANUP = 'https://hc-ping.com/abc';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(withDeadman('CLEANUP', () => true, async () => 42)).resolves.toBe(42);
  });
});
