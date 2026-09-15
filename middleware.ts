import { NextResponse, type NextRequest } from 'next/server';

// ⚡ HOST-BASED ROUTING FOR app.abapays.com
//
// Adding a custom domain to a Vercel project points that ENTIRE app at the domain — every
// route, same as the primary domain. There is no per-path domain scoping in Vercel itself.
// So once app.abapays.com is added to this project, visiting it would render the normal
// AbaPay bill-payment app (the same thing abapays.com shows) unless something rewrites it.
//
// This is that something. Any request whose Host header is app.abapays.com is rewritten to
// /masonode — a standalone corporate landing page for Masonode Technologies Limited (the
// entity Monnify's business verification is checking), regardless of what path was
// requested. abapays.com and www.abapays.com are untouched and keep serving the real app
// exactly as before; this middleware only ever acts on the app. subdomain.
//
// 🔴 WHY REWRITE EVERY PATH, NOT JUST "/". Monnify (or anyone else) may follow a link that
// isn't the bare root — a crawler probing /favicon.ico, a reviewer clicking a deep link from
// an email. Rewriting the whole host to the same single page means there is no path on this
// subdomain that falls through to the AbaPay app underneath, which is the one thing this
// middleware exists to prevent.
//
// ⚡ THE SAME MOVE FOR agents.abapays.com / rails.abapays.com — see src/app/agents/ for why
// this exists at all. Unlike app.abapays.com above, this is NOT a single static page standing
// in for the whole host: it's a real multi-page site (src/app/agents/{x402,a2a,mcp,sdk,
// channels,about}/page.tsx, all sharing src/app/agents/layout.tsx) with its OWN clean URL
// space on this host — agents.abapays.com/x402, not agents.abapays.com/agents/x402.
//
// So every path gets prefixed with /agents EXCEPT: paths already under /agents (avoid double-
// prefixing when someone follows a stray abapays.com/agents/... link onto this host), /api
// (MCP, x402, the REST surface — real endpoints, must resolve exactly as-is), /.well-known
// (the Agent Card, OAuth discovery), /docs /terms /privacy /receipt (real shared pages a
// developer landing on this domain legitimately wants — and, just as importantly, letting them
// resolve AS-IS means a relative link to them from an /agents/* page stays on this host instead
// of bouncing to abapays.com), and anything that looks like a static file (has a dot in its
// last segment — favicon.ico, logo.png, robots.txt, an opengraph-image route) since those are
// served from their real path regardless of which "page" is asking for them.
const AGENT_HOSTS = new Set(['agents.abapays.com', 'rails.abapays.com']);
const AGENT_HOST_SKIP = /^\/(api|\.well-known|agents|docs|terms|privacy|receipt)(\/|$)/;
const LOOKS_LIKE_STATIC_FILE = /\.[a-zA-Z0-9]+$/;

// ⚡ CORS FOR THE PUBLIC AGENT-FACING API SURFACE — exact-path allowlist, deliberately narrow.
// Without this, a browser-based agent (including agents.abapays.com's own "try it" panels)
// gets silently blocked calling these from a different origin: no Access-Control-Allow-Origin
// header meant every cross-origin fetch() failed before JS ever saw a response, regardless of
// whether the request itself would have succeeded. These four are exactly the endpoints this
// site documents as safe for a third party to call directly — x402 (EIP-712-signed, no
// cookies), MCP (bearer/api_key, no cookies), A2A (same), and the headless wallet-signature
// link flow (no cookies either). Nothing session/cookie-based is in this set on purpose: e.g.
// src/app/api/pay/route.ts (the logged-in-app checkout path) is a SEPARATE file from
// src/app/api/pay/x402/route.ts and never matches this allowlist.
const CORS_API_PATHS = new Set(['/api/mcp', '/api/pay/x402', '/api/a2a', '/api/agent/link']);
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-PAYMENT, x-wallet-address, x-wallet-signature, x-wallet-timestamp',
  'Access-Control-Max-Age': '86400',
};

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') || '';
  // Strip a port if present (local dev / preview URLs) before comparing.
  const hostname = host.split(':')[0];
  const { pathname } = req.nextUrl;

  if (CORS_API_PATHS.has(pathname)) {
    // Preflight never reaches the route handler (none of these export OPTIONS) — answer it
    // here so the browser's actual request is even attempted.
    if (req.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
    }
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  }

  if (hostname === 'app.abapays.com' && !req.nextUrl.pathname.startsWith('/masonode')) {
    const url = req.nextUrl.clone();
    url.pathname = '/masonode';
    return NextResponse.rewrite(url);
  }

  if (AGENT_HOSTS.has(hostname)) {
    if (!AGENT_HOST_SKIP.test(pathname) && !LOOKS_LIKE_STATIC_FILE.test(pathname)) {
      const url = req.nextUrl.clone();
      url.pathname = pathname === '/' ? '/agents' : `/agents${pathname}`;
      return NextResponse.rewrite(url);
    }
  }

  return NextResponse.next();
}

// Run on every path except static assets and Next internals — those need to keep resolving
// normally (JS chunks, images, etc.) even on the app. host, since /masonode itself pulls in
// the app's shared bundle via the root layout.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
