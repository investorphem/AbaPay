import 'server-only';
import celoChainQueryIds from '@/lib/dune/celo-query-ids.json';

// ⚡ THE FOUR NUMBERS ON agents.abapays.com'S HERO GRID — CELO-ONLY, deliberately.
//
// agents.abapays.com's whole pitch is Celo agent-payment rails, not "Celo and Base" — mixing
// in Base volume here would understate the Celo-only story this page exists to tell (see the
// file-level comment on src/app/agents/page.tsx). This used to combine both chains via a
// dedicated Dune query (8690659, UNIONing the two chains' root event tables) that needed
// `medium` performance and was never verified against this app's real DUNE_API_KEY — see git
// history. Going Celo-only removes that query entirely: these two reads are the SAME queries
// already in daily use by the Celo dashboard (dune/celo-chain/10_kpi_summary.sql and
// 12_by_rail.sql, refreshed daily by the existing `celo` branch of
// src/app/api/cron/dune-refresh/route.ts) — no new query, no new cron branch, no tier
// uncertainty. Both read a matview and cost a fraction of a credit each.
//
// Both reads are via Dune's GET /query/{id}/results — read-only per Dune's own docs ("get the
// latest query result without triggering an execution"), so this function never spends
// credits and can't fail from a performance-tier rejection.

const KPI_QUERY_ID = celoChainQueryIds.queries['10_kpi_summary.sql'];
const RAIL_QUERY_ID = celoChainQueryIds.queries['12_by_rail.sql'];

export type AgentStats = {
  volumeUsd: number;
  agentNativePct: number;
  uniqueWallets: number;
  transactions: number;
};

// Last known-good snapshot, used ONLY if the live fetch fails outright (missing API key,
// network error, Dune outage). Captured 2026-09-13, Celo mainnet only. Deliberately not a
// rounder-looking placeholder, so a viewer seeing it is a sign something upstream is broken.
const FALLBACK: AgentStats = {
  volumeUsd: 26992,
  agentNativePct: 96.6,
  uniqueWallets: 211,
  transactions: 3689,
};

async function duneGet(queryId: number, apiKey: string, limit: number): Promise<Record<string, unknown>[] | null> {
  const res = await fetch(`https://api.dune.com/api/v1/query/${queryId}/results?limit=${limit}`, {
    headers: { 'X-DUNE-API-KEY': apiKey },
    // Re-checked at most every hour — the underlying result only actually changes once a day
    // (the cron), so this just bounds how stale a serverless cold start can ever be.
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.result?.rows ?? null;
}

export async function getAgentStats(): Promise<AgentStats> {
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey || typeof KPI_QUERY_ID !== 'number' || typeof RAIL_QUERY_ID !== 'number') return FALLBACK;

  try {
    const [kpiRows, railRows] = await Promise.all([
      duneGet(KPI_QUERY_ID, apiKey, 1),
      duneGet(RAIL_QUERY_ID, apiKey, 1000), // ~76 rows today (one per day x rail); room to grow
    ]);
    const kpi = kpiRows?.[0];
    if (!kpi || !railRows) return FALLBACK;

    const volumeUsd = Number(kpi.volume_usd);
    const transactions = Number(kpi.payments);
    const uniqueWallets = Number(kpi.unique_payers);

    // Agent-native = everything that ISN'T a human signing in the app themselves —
    // "Agent (relayer)" and "x402" — as a share of total volume. Same definition
    // dune/celo-chain/12_by_rail.sql's own header comment uses.
    let agentNativeVolume = 0;
    let totalVolume = 0;
    for (const row of railRows) {
      const v = Number(row.volume_usd) || 0;
      totalVolume += v;
      if (row.rail === 'Agent (relayer)' || row.rail === 'x402') agentNativeVolume += v;
    }
    const agentNativePct = totalVolume > 0 ? (100 * agentNativeVolume) / totalVolume : 0;

    if (![volumeUsd, agentNativePct, uniqueWallets, transactions].every(Number.isFinite)) {
      return FALLBACK;
    }
    return { volumeUsd, agentNativePct, uniqueWallets, transactions };
  } catch {
    return FALLBACK;
  }
}
