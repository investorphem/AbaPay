import { describe, it, expect } from 'vitest';
import { feeCurrencyFor } from '@/lib/feeCurrency';

// The network fee is paid in the stablecoin the customer pays with — never USDm for everyone.
// Addresses read from Celo's FeeCurrencyDirectory (0x15F344b9…6276) on 2026-11-20.
describe('feeCurrencyFor', () => {
  it('names each stablecoin\'s own fee currency on mainnet: the adapter for 6-decimal tokens, USDm itself', () => {
    expect(feeCurrencyFor('USDC', true)).toBe('0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B');
    expect(feeCurrencyFor('USD₮', true)).toBe('0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72');
    expect(feeCurrencyFor('USA₮', true)).toBe('0x0357EE22278c922e1D36cFe6b899269b161880C4');
    expect(feeCurrencyFor('USDm', true)).toBe('0x765DE816845861e75A25fCA122bb6898B8B1282a');
  });

  it('never names the 6-decimal token itself, which the chain refuses as a fee currency', () => {
    expect(feeCurrencyFor('USDC', true)).not.toBe('0xcebA9300f2b948710d2653dD7B07f33A8B32118C');
    expect(feeCurrencyFor('USD₮', true)?.toLowerCase()).not.toBe('0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e');
  });

  it('leaves a token with no fee currency to pay gas in CELO', () => {
    expect(feeCurrencyFor('WETH', true)).toBeUndefined();
  });

  it('uses the testnet USDm on Celo Sepolia', () => {
    expect(feeCurrencyFor('USDC', false)).toBe('0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b');
  });
});
