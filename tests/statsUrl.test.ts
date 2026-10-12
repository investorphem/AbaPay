import { describe, it, expect, vi, afterEach } from 'vitest';
import { statsHref } from '../src/lib/onchain/statsUrl';

// The redirect from agents.abapays.com/stats must leave the agents host: a same-host /stats path is
// rewritten back into /agents/stats there and loops.
describe('statsHref', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('points at stats.abapays.com outside next dev, whatever NEXT_PUBLIC_APP_URL says', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://abapay.vercel.app');
    expect(statsHref()).toBe('https://stats.abapays.com/');
    expect(statsHref('/celo')).toBe('https://stats.abapays.com/celo');
    expect(statsHref('/base')).toBe('https://stats.abapays.com/base');
  });

  it('uses the /stats path under next dev', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(statsHref('/base')).toBe('/stats/base');
    expect(statsHref()).toBe('/stats');
  });
});
