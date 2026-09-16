import 'server-only';

// ⚡ LIVE, NOT SNAPSHOTTED — same pattern as src/lib/dune/agentStats.ts: real numbers from the
// real public APIs (npm, GitHub — both unauthenticated, no key to manage), revalidated
// periodically, with a null field meaning "couldn't fetch" rather than a fabricated number.
// PyPI is deliberately excluded here — pypistats.org 404s for a package in its first ~24h
// (abapay-sdk published 2026-09-16), so a download count for it would just be permanently
// broken on a fresh deploy; the discovery section links to the PyPI page itself instead.

export type DiscoveryStats = {
  npmDownloadsLastMonth: number | null;
  githubStars: number | null;
  githubForks: number | null;
};

const FALLBACK: DiscoveryStats = {
  npmDownloadsLastMonth: null,
  githubStars: null,
  githubForks: null,
};

export async function getDiscoveryStats(): Promise<DiscoveryStats> {
  try {
    const [npmRes, ghRes] = await Promise.all([
      fetch('https://api.npmjs.org/downloads/point/last-month/abapay-sdk', {
        next: { revalidate: 3600 },
      }),
      fetch('https://api.github.com/repos/investorphem/AbaPay', {
        headers: { 'User-Agent': 'agents.abapays.com', Accept: 'application/vnd.github+json' },
        next: { revalidate: 3600 },
      }),
    ]);

    const npmJson = npmRes.ok ? await npmRes.json().catch(() => null) : null;
    const ghJson = ghRes.ok ? await ghRes.json().catch(() => null) : null;

    const npmDownloadsLastMonth = Number.isFinite(npmJson?.downloads) ? npmJson.downloads : null;
    const githubStars = Number.isFinite(ghJson?.stargazers_count) ? ghJson.stargazers_count : null;
    const githubForks = Number.isFinite(ghJson?.forks_count) ? ghJson.forks_count : null;

    return { npmDownloadsLastMonth, githubStars, githubForks };
  } catch {
    return FALLBACK;
  }
}
