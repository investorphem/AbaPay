// Which contracts and tokens the on-chain index covers. Mainnet only: the index exists to report
// real activity, and the testnet vaults would only dilute it.
//
// Every AbaPay vault ever deployed on each chain, and every stablecoin they have accepted.
// `startBlock` is each vault's deployment block, read from its creation transaction (Celo V3/V4),
// from the V1 deployment record (Celo V1, 2026-04-07) or by bisecting eth_getCode (Base). Nothing can have been paid into a vault before it existed,
// so indexing starts at the earliest of them.

export type OnchainChain = 'CELO' | 'BASE';

export type VaultDef = { address: `0x${string}`; label: string; startBlock: bigint };
export type TokenDef = { address: `0x${string}`; symbol: string; decimals: number };

export type ChainIndexConfig = {
  chainId: number;
  vaults: VaultDef[];
  tokens: TokenDef[];
  /** Blocks to stay behind the head, so a reorg can't leave a payment indexed that isn't final. */
  confirmations: bigint;
  /** eth_getLogs range to start with. The indexer halves it when a provider refuses a range. */
  maxRange: bigint;
  explorer: string;
};

export const ONCHAIN_CHAINS: Record<OnchainChain, ChainIndexConfig> = {
  CELO: {
    chainId: 42220,
    vaults: [
      { address: '0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C', label: 'AbaPay V4 (current)', startBlock: BigInt(72758550) },
      { address: '0x42Fa463798Ed129a9B5Ee51721CB6db1bfCBe3b9', label: 'AbaPay V3', startBlock: BigInt(72213205) },
      { address: '0x1d12519876a116fc92236bb6cb8eff6243d65eaa', label: 'AbaPay V1 (original)', startBlock: BigInt(63661661) },
    ],
    tokens: [
      { address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', symbol: 'USDC', decimals: 6 },
      { address: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', symbol: 'USD₮', decimals: 6 },
      { address: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', symbol: 'USA₮', decimals: 6 },
      // Legacy and 18-decimal. Not offered for new payments, but old contract payments used it,
      // and reading them with 6 decimals would inflate them by 10^12.
      { address: '0x765de816845861e75a25fca122bb6898b8b1282a', symbol: 'USDm', decimals: 18 },
    ],
    confirmations: BigInt(5),
    maxRange: BigInt(10_000),
    explorer: 'https://celoscan.io',
  },
  BASE: {
    chainId: 8453,
    vaults: [
      { address: '0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488', label: 'AbaPay V4 (current)', startBlock: BigInt(48935050) },
      { address: '0xF3AeFF0c326B1277A2D8623b7694aEB5E6A565e5', label: 'AbaPay V1 (original)', startBlock: BigInt(45399063) },
    ],
    tokens: [
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
      { address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', symbol: 'USDT', decimals: 6 },
    ],
    confirmations: BigInt(10),
    maxRange: BigInt(10_000),
    explorer: 'https://basescan.org',
  },
};

// PaymentReceived(address indexed user, address indexed token, string serviceType, string accountNumber, uint256 amount)
export const PAYMENT_RECEIVED_TOPIC = '0x8c69ba65ac630960f1d90c9a12eb143096fa71019450181b7fb5c299f03a6357';
// AgentPayment(address,address,uint256,uint256): emitted alongside PaymentReceived when the relayer
// spent a user's allowance. Its presence is what makes a contract payment the agent rail.
export const AGENT_PAYMENT_TOPIC = '0x90619b8207d57f0cc87c98e7c2fdb86c6f12683d8a29412b02d558b3be68e6cd';
// Transfer(address indexed from, address indexed to, uint256 value)
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** The two attribution tags AbaPay puts on Celo transactions (src/lib/attribution.ts). */
export const HACKATHON_TAG = 'celo_2719403c6aff';
export const BUILDERS_TAG = 'celo_9d71588659ec';
