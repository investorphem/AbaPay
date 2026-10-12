// Where the analytics site lives: its own host, stats.abapays.com (middleware.ts rewrites that host
// onto src/app/stats). Only `next dev` uses the /stats path on the same host instead, since there
// is no stats host on localhost.
//
// 🔴 NOT DECIDED FROM NEXT_PUBLIC_APP_URL. The first version did that, the way getAgentAppUrl()
// does, but production's value isn't an abapays.com URL, so it fell back to "/stats". On the agents
// host that path is rewritten back into /agents/stats, which redirected to itself: a redirect loop
// on agents.abapays.com/stats/base. Previews link to the live site, which is the right place for
// a visitor anyway.

export function statsBase(): string {
  return process.env.NODE_ENV === 'development' ? '/stats' : 'https://stats.abapays.com';
}

/** A page on the analytics site: '' (overview), '/celo' or '/base'. */
export function statsHref(page: '' | '/celo' | '/base' = ''): string {
  const base = statsBase();
  return page === '' ? (base === '/stats' ? '/stats' : `${base}/`) : `${base}${page}`;
}
