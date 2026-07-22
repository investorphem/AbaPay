import { celo, celoSepolia, base, baseSepolia } from 'viem/chains';
import { toDataSuffix } from '@celo/attribution-tags';

// ─── CELO BUILDERS ON-CHAIN ATTRIBUTION ───────────────────────────────────────
//
// This is our Celo Builders attribution tag (assigned at registration, locked to our
// GitHub repo). The Dune leaderboard only credits transactions whose calldata carries
// THIS exact tag, so it must ride in every Celo transaction we send.
//
// ⚠️ CELO ONLY. `celoAttributionSuffix()` returns undefined for Base — see
// `baseAttributionSuffix()` below for Base's own (differently-formatted) builder code.
export const CELO_ATTRIBUTION_TAG = 'celo_9d71588659ec';

// Precompute the ERC-8021 data suffix once — it never changes.
const CELO_DATA_SUFFIX = toDataSuffix(CELO_ATTRIBUTION_TAG);

// Celo mainnet (42220) and Celo Sepolia (11142220).
const CELO_CHAIN_IDS = new Set<number>([celo.id, celoSepolia.id]);

/**
 * The attribution data suffix to pass to viem's `dataSuffix` option — but ONLY for Celo
 * chains. Returns `undefined` for Base (and anything else), so the call is left untouched.
 *
 * Accepts a viem chain object, a numeric chain id, or the app's 'CELO' | 'BASE' string,
 * so it drops into every transaction site regardless of what chain info is on hand.
 */
export function celoAttributionSuffix(
  chain?: number | string | { id?: number; name?: string } | null,
): `0x${string}` | undefined {
  if (chain === null || chain === undefined) return undefined;
  if (typeof chain === 'number') return CELO_CHAIN_IDS.has(chain) ? CELO_DATA_SUFFIX : undefined;
  if (typeof chain === 'string') return chain.toUpperCase().includes('CELO') ? CELO_DATA_SUFFIX : undefined;
  if (typeof chain.id === 'number') return CELO_CHAIN_IDS.has(chain.id) ? CELO_DATA_SUFFIX : undefined;
  if (chain.name) return chain.name.toUpperCase().includes('CELO') ? CELO_DATA_SUFFIX : undefined;
  return undefined;
}

// ─── BASE BUILDER CODE ON-CHAIN ATTRIBUTION ───────────────────────────────────
//
// Base's own ERC-8021-based attribution scheme (docs.base.org/apps/builder-codes) — a
// separate registration from Celo's, with its own code and its own pre-encoded suffix
// (Base's format embeds the code text directly rather than through toDataSuffix, hence
// the literal hex constant rather than a toDataSuffix() call like Celo's above).
//
// Registered code: bc_jcuz1f23. Previously only applied to the user's own direct payBill()
// calls (src/app/page.tsx) — the relayer's payBillFor() calls on Base carried NO attribution
// at all until this was added here, mirroring celoAttributionSuffix's pattern so both chains'
// tagging lives in one place instead of being duplicated per call site.
const BASE_DATA_SUFFIX: `0x${string}` = '0x62635f6a63757a316632330b0080218021802180218021802180218021';

// Base mainnet (8453) and Base Sepolia (84532).
const BASE_CHAIN_IDS = new Set<number>([base.id, baseSepolia.id]);

/**
 * The attribution data suffix to pass to viem's `dataSuffix` option — but ONLY for Base
 * chains. Returns `undefined` for Celo (and anything else), mirroring celoAttributionSuffix.
 */
export function baseAttributionSuffix(
  chain?: number | string | { id?: number; name?: string } | null,
): `0x${string}` | undefined {
  if (chain === null || chain === undefined) return undefined;
  if (typeof chain === 'number') return BASE_CHAIN_IDS.has(chain) ? BASE_DATA_SUFFIX : undefined;
  if (typeof chain === 'string') return chain.toUpperCase().includes('BASE') ? BASE_DATA_SUFFIX : undefined;
  if (typeof chain.id === 'number') return BASE_CHAIN_IDS.has(chain.id) ? BASE_DATA_SUFFIX : undefined;
  if (chain.name) return chain.name.toUpperCase().includes('BASE') ? BASE_DATA_SUFFIX : undefined;
  return undefined;
}
