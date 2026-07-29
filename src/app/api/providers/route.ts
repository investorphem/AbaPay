import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getCatalog, resolveCategory } from '@/lib/vtpassCatalog';

// ⚡ THE BROWSER'S DOOR INTO THE LIVE VTpass CATALOGUE.
//
// VTpass credentials are server-only (src/lib/vtpass.js is `import 'server-only'`), so the web
// app's provider pickers cannot call vtpass.com directly — they call here instead of importing
// a static array. Chat and MCP skip this route entirely and call getCatalog() in-process; both
// paths land on the SAME module-level cache, so there is exactly one source of truth.
//
// ⚡ WHY THIS IS FASTER THAN THE HARDCODED LISTS IT REPLACES (goal (c)):
// the old lists were "hardcoded but still sometimes slow-loading" because the NAMES were local
// but each LOGO was a separate request for a bundled PNG that missed cache on first paint. Now
// a single JSON response carries every name, logo URL and limit for a whole category, VTpass is
// hit at most once an hour per server instance (vtpassCatalog's TTL cache), and the response
// below is marked cacheable so the browser/CDN serves repeat page loads without touching us.

// ⚡ Deliberately NOT using route segment config (`export const revalidate`): Next 16 removes
// `revalidate`/`dynamic` when Cache Components is enabled, so the caching would silently stop
// applying on a config flag change. An explicit Cache-Control header plus the module-level TTL
// cache underneath is version-independent and does the same job.
const CACHE_HEADER = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

export async function GET(request: Request) {
  // 🛡️ A cache miss here proxies a billable VTpass request — throttle abuse (60/min per IP),
  // matching /api/variations and /api/intl.
  const limited = await enforceRateLimit(request, 'providers', 60, 60);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  // Accepts either the friendly name the UI thinks in ("cable", "internet") or the raw VTpass
  // identifier ("tv-subscription", "data") — resolveCategory maps both.
  const requested = searchParams.get('category') || searchParams.get('identifier') || '';
  const category = resolveCategory(requested);

  if (!category) {
    return NextResponse.json(
      { error: 'Unknown category. Expected one of: airtime, data, electricity, cable, education.' },
      { status: 400 }
    );
  }

  // getCatalog never throws and never returns an empty list — it degrades to the last-known-good
  // cache and then to the bundled seed — so there is no failure branch that can blank a picker.
  const { providers, stale } = await getCatalog(category);

  return NextResponse.json(
    { category, providers, stale },
    {
      // A stale answer is still worth serving, but it must not be cached for an hour at the edge
      // or a brief VTpass blip would freeze the degraded list in place long after recovery.
      headers: { 'Cache-Control': stale ? 'no-store' : CACHE_HEADER },
    }
  );
}
