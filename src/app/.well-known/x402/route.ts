import { NextResponse } from 'next/server';

// ⚡ x402 DISCOVERY MANIFEST — the x402 ecosystem's convention for "which of this origin's URLs
// are paid x402 resources": `{ version: 1, resources: [...] }` at /.well-known/x402. Indexers
// (e.g. agent402.tools, which registers an origin by POST /api/index/register and re-probes it
// every 30 minutes) read this first, then probe each resource for its live 402 challenge, which
// is where the real price, networks and assets come from. So this file names the endpoint and
// says what it is, and deliberately repeats nothing the challenge itself is the authority on.
//
// Served as a route rather than a static file so every URL matches the deployment it is served
// from (preview deploys included), the same reason /.well-known/agent-card.json is a route.

export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  return NextResponse.json(
    {
      version: 1,
      resources: [`${origin}/api/pay/x402`],
      name: 'AbaPay',
      description:
        'Pay real-world bills with stablecoins over x402: airtime, data, electricity, cable TV and education in Nigeria, plus international airtime and data in 140+ countries. The 402 challenge on each resource carries the exact price, networks and assets.',
      homepage: origin,
      openapi: `${origin}/openapi.json`,
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
