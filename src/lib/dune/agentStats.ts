import 'server-only';
import agentStatsQueryId from '@/lib/dune/agents-page-stats-query-id.json';

// ⚡ THE FOUR NUMBERS ON agents.abapays.com'S HERO GRID — previously hardcoded strings
// ("$34,519" etc., see git history on src/app/agents/page.tsx) with a caption disclaiming
// "as of 2026-09-11". That's a real problem for a page whose whole pitch is "check the
// on-chain numbers yourself" — a reviewer who did exactly that would find the live dashboards
// disagreeing with the static hero numbers within days.
//
// This reads dune/agents-page-stats/00_summary.sql's cached results via Dune's GET
// /query/{id}/results endpoint. That endpoint is READ-ONLY — per Dune's own docs, "get the
// latest query result without triggering an execution" — so calling it costs no Dune credits
// and cannot fail from a performance-tier rejection. Keeping the underlying result itself
// fresh is a SEPARATE concern, handled by the "agents-stats" branch of
// src/app/api/cron/dune-refresh/route.ts; if that ever stops running, this function keeps
// serving whatever the last successful execution produced (results persist 90 days per Dune),
// degrading to a stale-but-real number rather than an error.

export type AgentStats = {
  volumeUsd: number;
  agentNativePct: number;
  uniqueWallets: number;
  transactions: number;
};

// Last known-good snapshot, used ONLY if the live fetch fails outright (missing API key,
// network error, Dune outage, or a 90-day-old query that has never been executed at all).
// Captured 2026-09-13 from this exact query — see dune/agents-page-stats/00_summary.sql.
// If this is ever what a viewer actually sees, something upstream is broken; it is
// deliberately not a rounder-looking placeholder so that's noticeable rather than plausible.
const FALLBACK: AgentStats = {
  volumeUsd: 32741,
  agentNativePct: 84.6,
  uniqueWallets: 400,
  transactions: 15955,
};

export async function getAgentStats(): Promise<AgentStats> {
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) return FALLBACK;

  try {
    const res = await fetch(
      `https://api.dune.com/api/v1/query/${agentStatsQueryId.queryId}/results?limit=1`,
      {
        headers: { 'X-DUNE-API-KEY': apiKey },
        // Re-checked at most every hour. The underlying result itself only actually changes
        // once a day (see the cron), so this is about bounding how stale a serverless cold
        // start can ever be, not about catching every refresh instantly.
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return FALLBACK;

    const json = await res.json();
    const row = json?.result?.rows?.[0];
    if (!row) return FALLBACK;

    const volumeUsd = Number(row.volume_usd);
    const agentNativePct = Number(row.agent_native_pct);
    const uniqueWallets = Number(row.unique_wallets);
    const transactions = Number(row.transactions);
    if (![volumeUsd, agentNativePct, uniqueWallets, transactions].every(Number.isFinite)) {
      return FALLBACK;
    }
    return { volumeUsd, agentNativePct, uniqueWallets, transactions };
  } catch {
    return FALLBACK;
  }
}
