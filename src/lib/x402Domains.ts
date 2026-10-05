// Per-token EIP-712 domains for x402 (EIP-3009 transferWithAuthorization), per chain.
//
// The name/version MUST match each token's own on-chain EIP712Domain or the payer's signature
// won't verify. Base USDC's domain name is "USD Coin" (not Celo USDC's "USDC"), a different
// token contract entirely. test/fork/vaults.fork.ts checks every entry here against the live
// token contract's DOMAIN_SEPARATOR every night, and settles a real authorization with it.
//
// Base x402 supports USDC ONLY: Base USDT has no EIP-3009 transferWithAuthorization (verified
// on-chain: version()/DOMAIN_SEPARATOR() revert), so it can't be settled "exact".
export const X402_DOMAINS_BY_CHAIN: Record<'CELO' | 'BASE', Record<string, { name: string; version: string }>> = {
  CELO: {
    USDC: { name: 'USDC', version: '2' },
    'USD₮': { name: 'Tether USD', version: '1' },
    // ⚡ USA₮ (Tether America USD) — verified the same way every other entry here was: its
    // on-chain DOMAIN_SEPARATOR (0xe6bbb792…) is reproduced exactly by this name/version pair
    // against chainId 42220 and 0xD2ab3C9A…F771. Note the name is the TOKEN's full name, not
    // its symbol — signing "USA₮" here would recover to an unrelated address and revert.
    'USA₮': { name: 'Tether America USD', version: '1' },
  },
  BASE: {
    USDC: { name: 'USD Coin', version: '2' },
  },
};
