import { createPublicClient, http } from 'viem';
import { base, baseSepolia, celo, celoSepolia } from 'viem/chains';
import { verifySignatureAcrossChains } from '@/utils/walletAuth';

const OWNER_ABI = [
  { inputs: [], name: 'owner', outputs: [{ internalType: 'address', name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
] as const;

// How long a signed admin session stays valid (12 hours)
const MAX_SESSION_AGE_MS = 12 * 60 * 60 * 1000;
// Cache the on-chain owner lookup for 10 minutes
const OWNER_CACHE_MS = 10 * 60 * 1000;

let cachedOwner: { address: string; fetchedAt: number } | null = null;

async function getAdminAddress(): Promise<string | null> {
  // 1. Preferred: explicit env var (no RPC dependency)
  if (process.env.ADMIN_WALLET_ADDRESS) return process.env.ADMIN_WALLET_ADDRESS;

  // 2. Fallback: read owner() from the AbaPay contract on-chain
  if (cachedOwner && Date.now() - cachedOwner.fetchedAt < OWNER_CACHE_MS) return cachedOwner.address;

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_NETWORK === 'celo' || process.env.NEXT_PUBLIC_NETWORK === 'base';
  const celoContract = process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS;
  const baseContract = process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS;

  const useCelo = !!(celoContract && celoContract.length === 42);
  const contractAddress = useCelo ? celoContract : baseContract;
  if (!contractAddress || contractAddress.length !== 42) return null;

  const chain = useCelo ? (isMainnet ? celo : celoSepolia) : (isMainnet ? base : baseSepolia);
  let rpcUrl: string = chain.rpcUrls.default.http[0];
  if (chain.id === celo.id) rpcUrl = 'https://forno.celo.org';
  if (chain.id === base.id) rpcUrl = 'https://mainnet.base.org';

  try {
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    const owner = (await client.readContract({ address: contractAddress as `0x${string}`, abi: OWNER_ABI, functionName: 'owner' })) as string;
    cachedOwner = { address: owner, fetchedAt: Date.now() };
    return owner;
  } catch {
    return null;
  }
}

// 🔐 SERVER-SIDE ADMIN CHECK
// Verifies that the request carries a valid session signature produced by the
// contract owner wallet. Used by every /api/admin/* route.
export async function verifyAdminRequest(req: Request): Promise<{ authorized: boolean; message: string; address?: string }> {
  const address = req.headers.get('x-admin-address');
  const signature = req.headers.get('x-admin-signature');
  const timestamp = req.headers.get('x-admin-timestamp');

  if (!address || !signature || !timestamp) {
    return { authorized: false, message: 'Unauthorized: missing admin authentication headers.' };
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Date.now() - ts > MAX_SESSION_AGE_MS || ts > Date.now() + 5 * 60 * 1000) {
    return { authorized: false, message: 'Unauthorized: admin session expired. Please reconnect your wallet.' };
  }

  const adminAddress = await getAdminAddress();
  if (!adminAddress) {
    return { authorized: false, message: 'Server misconfigured: set ADMIN_WALLET_ADDRESS or a contract address env var.' };
  }

  if (address.toLowerCase() !== adminAddress.toLowerCase()) {
    return { authorized: false, message: 'Unauthorized: not the admin wallet.' };
  }

  // Smart-wallet-aware (Coinbase Smart Wallet / Base Account, Safe, etc. via ERC-1271/6492,
  // with a plain ECDSA fast path for ordinary EOAs) — see src/utils/walletAuth.ts.
  const valid = await verifySignatureAcrossChains(address, `AbaPay Admin Login: ${timestamp}`, signature);
  if (!valid) return { authorized: false, message: 'Unauthorized: invalid signature.' };

  return { authorized: true, message: 'OK', address };
}
