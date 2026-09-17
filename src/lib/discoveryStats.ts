import 'server-only';

// ⚡ LIVE, NOT SNAPSHOTTED — same pattern as src/lib/dune/agentStats.ts: real numbers from the
// real public APIs (npm, PyPI, GitHub — all unauthenticated, no key to manage), revalidated
// periodically, with a null field meaning "couldn't fetch" rather than a fabricated number.
// pypistats.org 404s for a package in its first ~24h after publish; past that window it
// returns real data (verified 2026-09-17, a day after abapay-sdk's 2026-09-16 publish), so
// this fetches it the same way as npm/GitHub and lets a null render as "—" on a fresh deploy
// rather than special-casing it as permanently unavailable.

export type DiscoveryStats = {
  npmDownloadsLastMonth: number | null;
  pypiDownloadsLastMonth: number | null;
  githubStars: number | null;
  githubForks: number | null;
};

const FALLBACK: DiscoveryStats = {
  npmDownloadsLastMonth: null,
  pypiDownloadsLastMonth: null,
  githubStars: null,
  githubForks: null,
};

export async function getDiscoveryStats(): Promise<DiscoveryStats> {
  try {
    const [npmRes, pypiRes, ghRes] = await Promise.all([
      fetch('https://api.npmjs.org/downloads/point/last-month/abapay-sdk', {
        next: { revalidate: 3600 },
      }),
      fetch('https://pypistats.org/api/packages/abapay-sdk/recent', {
        headers: { 'User-Agent': 'agents.abapays.com' },
        next: { revalidate: 3600 },
      }),
      fetch('https://api.github.com/repos/investorphem/AbaPay', {
        headers: { 'User-Agent': 'agents.abapays.com', Accept: 'application/vnd.github+json' },
        next: { revalidate: 3600 },
      }),
    ]);

    const npmJson = npmRes.ok ? await npmRes.json().catch(() => null) : null;
    const pypiJson = pypiRes.ok ? await pypiRes.json().catch(() => null) : null;
    const ghJson = ghRes.ok ? await ghRes.json().catch(() => null) : null;

    const npmDownloadsLastMonth = Number.isFinite(npmJson?.downloads) ? npmJson.downloads : null;
    const pypiDownloadsLastMonth = Number.isFinite(pypiJson?.data?.last_month) ? pypiJson.data.last_month : null;
    const githubStars = Number.isFinite(ghJson?.stargazers_count) ? ghJson.stargazers_count : null;
    const githubForks = Number.isFinite(ghJson?.forks_count) ? ghJson.forks_count : null;

    return { npmDownloadsLastMonth, pypiDownloadsLastMonth, githubStars, githubForks };
  } catch {
    return FALLBACK;
  }
}
