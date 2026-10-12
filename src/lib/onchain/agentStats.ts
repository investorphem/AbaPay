import 'server-only';
import { getOnchainSummary, RAIL_LABEL } from './stats';

// ⚡ THE NUMBERS ON agents.abapays.com'S HERO GRID — CELO-ONLY, deliberately.
//
// The site's pitch is Celo agent-payment rails, so Base volume stays out of it. The numbers come
// from AbaPay's own on-chain index, which reads the chain directly; stats.abapays.com shows them
// in full.

export type RailBreakdown = {
  rail: string;
  volumeUsd: number;
  payments: number;
  pct: number; // share of total volume, 0-100
};

export type AgentStats = {
  volumeUsd: number;
  agentNativePct: number;
  uniqueWallets: number;
  transactions: number;
  rails: RailBreakdown[];
};

// Last known-good snapshot, used ONLY if the index can't be read or is still empty. Captured
// 2026-09-13, Celo mainnet only. Deliberately not a rounder-looking placeholder, so a
// viewer seeing it is a sign something upstream is broken.
const FALLBACK: AgentStats = {
  volumeUsd: 26992,
  agentNativePct: 96.6,
  uniqueWallets: 211,
  transactions: 3689,
  rails: [
    { rail: 'x402', volumeUsd: 22392, payments: 1974, pct: 82.9 },
    { rail: 'Agent (relayer)', volumeUsd: 3287, payments: 1401, pct: 12.2 },
    { rail: 'Direct (wallet)', volumeUsd: 1313, payments: 314, pct: 4.9 },
  ],
};

export async function getAgentStats(): Promise<AgentStats> {
  const s = await getOnchainSummary('CELO');
  if (!s || Number(s.totals.payments) === 0) return FALLBACK;

  const volumeUsd = Number(s.totals.volume_usd);
  const agentVolume = Number(s.totals.agent_volume_usd);
  const rails = s.by_rail.map((r) => ({
    rail: RAIL_LABEL[r.rail],
    volumeUsd: Number(r.volume_usd),
    payments: Number(r.payments),
    pct: volumeUsd > 0 ? (100 * Number(r.volume_usd)) / volumeUsd : 0,
  }));
  return {
    volumeUsd,
    agentNativePct: volumeUsd > 0 ? (100 * agentVolume) / volumeUsd : 0,
    uniqueWallets: Number(s.totals.wallets),
    transactions: Number(s.totals.payments),
    rails,
  };
}
