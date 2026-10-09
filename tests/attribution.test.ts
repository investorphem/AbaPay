import { describe, it, expect } from 'vitest';
import { celo, celoSepolia, base } from 'viem/chains';
import { fromDataSuffix } from '@celo/attribution-tags';
import { celoAttributionSuffix, baseAttributionSuffix, CELO_ATTRIBUTION_TAGS } from '@/lib/attribution';

// The ERC-8021 attribution suffix appended to every Celo transaction AbaPay sends.

describe('celoAttributionSuffix', () => {
  it('carries BOTH Celo tags: the Open Rails hackathon one and the original Celo Builders one', () => {
    const suffix = celoAttributionSuffix(celo.id);
    expect(suffix).toBeDefined();
    const decoded = fromDataSuffix(suffix!);
    expect(decoded?.codes).toEqual(['celo_2719403c6aff', 'celo_9d71588659ec']);
    expect(CELO_ATTRIBUTION_TAGS).toContain('celo_2719403c6aff');
  });

  it('applies to Celo mainnet and testnet, and to the app\'s CELO chain name', () => {
    expect(celoAttributionSuffix(celoSepolia.id)).toBe(celoAttributionSuffix(celo.id));
    expect(celoAttributionSuffix('CELO')).toBe(celoAttributionSuffix(celo.id));
    expect(celoAttributionSuffix(celo)).toBe(celoAttributionSuffix(celo.id));
  });

  it('never tags a Base transaction with Celo codes (Base has its own builder code)', () => {
    expect(celoAttributionSuffix(base.id)).toBeUndefined();
    expect(celoAttributionSuffix('BASE')).toBeUndefined();
    expect(baseAttributionSuffix(base.id)).toBeDefined();
    expect(baseAttributionSuffix(celo.id)).toBeUndefined();
  });
});
