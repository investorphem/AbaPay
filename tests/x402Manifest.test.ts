import { describe, it, expect } from 'vitest';
import { GET } from '@/app/.well-known/x402/route';

// The /.well-known/x402 manifest x402 indexers (agent402.tools and others) read first.

describe('/.well-known/x402', () => {
  it('names the paid x402 endpoint on the origin it is served from', async () => {
    const res = GET(new Request('https://www.abapays.com/.well-known/x402'));
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.resources).toEqual(['https://www.abapays.com/api/pay/x402']);
    expect(body.openapi).toBe('https://www.abapays.com/openapi.json');
  });

  it('follows the deployment, so a preview never advertises production', async () => {
    const body = await GET(new Request('https://abapay-git-x.vercel.app/.well-known/x402')).json();
    expect(body.resources).toEqual(['https://abapay-git-x.vercel.app/api/pay/x402']);
  });
});
