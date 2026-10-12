// Where the analytics site lives. On any real abapays.com deployment that is its own host,
// stats.abapays.com (middleware.ts rewrites that host onto src/app/stats). Preview deployments and
// localhost have no such host, so there the same pages are reached at /stats on whatever host is
// serving. Same rule as getAgentAppUrl() uses for agents.abapays.com.

export function statsBase(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || '';
  try {
    if (/(^|\.)abapays\.com$/i.test(new URL(raw).hostname)) return 'https://stats.abapays.com';
  } catch {
    // not an absolute URL: fall through to the path form
  }
  return '/stats';
}

/** A page on the analytics site: '' (overview), '/celo' or '/base'. */
export function statsHref(page: '' | '/celo' | '/base' = ''): string {
  const base = statsBase();
  return page === '' ? (base === '/stats' ? '/stats' : `${base}/`) : `${base}${page}`;
}
