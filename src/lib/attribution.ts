import { celo, celoSepolia } from 'viem/chains';
import { toDataSuffix } from '@celo/attribution-tags';

// ─── CELO BUILDERS ON-CHAIN ATTRIBUTION ───────────────────────────────────────
//
// This is our Celo Builders attribution tag (assigned at registration, locked to our
// GitHub repo). The Dune leaderboard only credits transactions whose calldata carries
// THIS exact tag, so it must ride in every Celo transaction we send.
//
// ⚠️ CELO ONLY. Base transactions already carry their own existing builder code
// (see `builderCodeSuffix` in the payment flow) and must be left exactly as they are —
// `celoAttributionSuffix()` returns undefined for Base so viem appends nothing there.
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
