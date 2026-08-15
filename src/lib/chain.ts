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
//
// ⚡ EXPORTED because the BROWSER needs the same list. src/config/wagmi.ts used to build its
// transports with a bare `http()`, i.e. viem's single default endpoint per chain with no
// backup — so a user whose network can't reach `forno.celo.org` (some networks filter it)
// got a silently broken balance/allowance read even though the server side had failover.
// One list, both sides.
export function rpcUrlsFor(chainId: number): string[] {
  switch (chainId) {
    case celo.id:
      return ['https://forno.celo.org', 'https://rpc.ankr.com/celo'];
    case celoSepolia.id:
      return ['https://alfajores-forno.celo-testnet.org'];
    case 44787: // celoAlfajores — the browser config targets Alfajores, not celoSepolia
      return ['https://alfajores-forno.celo-testnet.org'];
    case base.id:
      return ['https://mainnet.base.org', 'https://base.publicnode.com', 'https://base-rpc.publicnode.com'];
    case baseSepolia.id:
      return ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
    default:
      return [];
  }
}

// Shared failover transport for a chain.
//
// 🔴 THE GAP THIS CLOSES: getPublicClient() below has had RPC failover since Audit v2, but
// src/lib/deai/relayer.ts built its WALLET client with a bare `http()` and no URL — i.e. viem's
// single default endpoint for the chain, with no backup. Every agent payment, every autonomous
// scheduled payment and every MCP pay_bill was submitted through that one unmonitored endpoint,
// so a single RPC outage silently stopped all autonomous spending while balance READS (which do
// have failover) kept working — a confusing, hard-to-diagnose split failure. Exporting the
// transport means the read and write paths can no longer drift apart.
export function getChainTransport(blockchain: string | null | undefined) {
  const { chain } = resolveChain(blockchain);
  const urls = rpcUrlsFor(chain.id);
  const transports = urls.length
    ? urls.map((u) => http(u))
    : [http(chain.rpcUrls.default.http[0])];
  // fallback() tries each transport in order, rolling over on failure.
  return fallback(transports);
}

export function getPublicClient(blockchain: string | null | undefined): PublicClient {
  const { chain } = resolveChain(blockchain);
  return createPublicClient({ chain, transport: getChainTransport(blockchain) }) as PublicClient;
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