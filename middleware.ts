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
export function middleware(req: NextRequest) {
  const host = req.headers.get('host') || '';
  // Strip a port if present (local dev / preview URLs) before comparing.
  const hostname = host.split(':')[0];

  if (hostname === 'app.abapays.com' && !req.nextUrl.pathname.startsWith('/masonode')) {
    const url = req.nextUrl.clone();
    url.pathname = '/masonode';
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

// Run on every path except static assets and Next internals — those need to keep resolving
// normally (JS chunks, images, etc.) even on the app. host, since /masonode itself pulls in
// the app's shared bundle via the root layout.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
