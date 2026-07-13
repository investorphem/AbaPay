import { createPublicClient, http, fallback, type PublicClient } from 'viem';
import { base, baseSepolia, celo, celoSepolia } from 'viem/chains';

// ⚡ SHARED CHAIN / RPC RESOLUTION
//
// Both /api/webhook and /api/admin/refund need to resolve "which chain + which RPC" for a
// transaction record and read receipts from it. This centralises that logic so the two
// paths can't drift apart (Audit v2, M-2), and adds RPC FAILOVER (Audit v2, #15): instead
// of a single hardcoded endpoint that is a single point of failure, we use viem's
// `fallback()` transport so a downed primary RPC automatically rolls over to a backup.

export function isMainnetEnv(): boolean {
  const n = process.env.NEXT_PUBLIC_NETWORK;
  return n === 'mainnet' || n === 'celo' || n === 'base';
}

export function resolveChain(blockchain: string | null | undefined) {
  const isMainnet = isMainnetEnv();
  const isBase = (blockchain || 'CELO').toUpperCase() === 'BASE';
  const chain = isBase ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);
  return { chain, isMainnet, isBase };
}

// Primary + backup RPC URLs per chain. Primary matches what the app used before;
// backups are well-known public endpoints so a single outage doesn't halt verification.
function rpcUrlsFor(chainId: number): string[] {
  switch (chainId) {
    case celo.id:
      return ['https://forno.celo.org', 'https://rpc.ankr.com/celo'];
    case celoSepolia.id:
      return ['https://alfajores-forno.celo-testnet.org'];
    case base.id:
      return ['https://mainnet.base.org', 'https://base.publicnode.com', 'https://base-rpc.publicnode.com'];
    case baseSepolia.id:
      return ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
    default:
      return [];
  }
}

export function getPublicClient(blockchain: string | null | undefined): PublicClient {
  const { chain } = resolveChain(blockchain);
  const urls = rpcUrlsFor(chain.id);
  const transports = urls.length
    ? urls.map((u) => http(u))
    : [http(chain.rpcUrls.default.http[0])];
  // fallback() tries each transport in order, rolling over on failure.
  return createPublicClient({ chain, transport: fallback(transports) }) as PublicClient;
}

export function explorerBaseFor(blockchain: string | null | undefined): string {
  const { chain } = resolveChain(blockchain);
  switch (chain.id) {
    case base.id: return 'https://basescan.org';
    case baseSepolia.id: return 'https://sepolia.basescan.org';
    case celo.id: return 'https://celoscan.io';
    default: return 'https://alfajores.celoscan.io';
  }
}
