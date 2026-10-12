import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

// Host-based routing: stats.abapays.com and agents.abapays.com each map their clean URLs onto
// their own route tree (src/app/stats, src/app/agents).

const run = (host: string, path: string) => middleware(new NextRequest(`https://${host}${path}`, { headers: { host } }));
const rewrittenTo = (res: Response) => {
  const to = res.headers.get('x-middleware-rewrite');
  return to ? new URL(to).pathname : null;
};

describe('stats.abapays.com', () => {
  it.each([
    ['/', '/stats'],
    ['/celo', '/stats/celo'],
    ['/base', '/stats/base'],
  ])('rewrites %s to %s', (path, to) => {
    expect(rewrittenTo(run('stats.abapays.com', path))).toBe(to);
  });

  it.each(['/api/onchain/export', '/stats/celo', '/logo.png'])('leaves %s alone', (path) => {
    expect(rewrittenTo(run('stats.abapays.com', path))).toBeNull();
  });
});

describe('agents.abapays.com still routes as before', () => {
  it('rewrites /x402 and leaves /api alone', () => {
    expect(rewrittenTo(run('agents.abapays.com', '/x402'))).toBe('/agents/x402');
    expect(rewrittenTo(run('agents.abapays.com', '/api/mcp'))).toBeNull();
  });
});

describe('other hosts', () => {
  it('does not rewrite www.abapays.com', () => {
    expect(rewrittenTo(run('www.abapays.com', '/celo'))).toBeNull();
  });
});
