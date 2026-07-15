import 'server-only';
import { getHeaders } from '@/lib/vtpass';
import { getPublicClient, isMainnetEnv } from '@/lib/chain';
import { SUPPORTED_TOKENS, resolveTokenOnChain } from '@/constants';
import { formatUnits } from 'viem';

// ⚡ DeAI REAL DATA LAYER
//
// Replaces the three stubbed functions that previously made DeAI a convincing SIMULATION:
//   verifyAccount()        -> returned { customer_name: "Verified User" } for ANY input
//   fetchDataVariations()  -> returned four hardcoded fake plans
//   fetchCryptoBalances()  -> returned "0.00" for everything
//
// Everything here hits the same real VTpass endpoints and the same on-chain reads the web
// app uses, so the agent and the app cannot disagree about what's true.

const ERC20_BALANCE_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
] as const;

function vtpassBaseUrl() {
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  return appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
}

export interface VerifiedAccount {
  success: boolean;
  customer_name?: string;
  customer_address?: string;
  min_amount?: number;
  max_amount?: number;
  message?: string;
}

/**
 * REAL merchant verification against VTpass.
 * Used for electricity meters, cable smartcards, and bank accounts — anything where the
 * user must confirm "yes, that's the right person" before money moves.
 */
export async function verifyAccount(
  serviceID: string,
  billersCode: string,
  type?: string
): Promise<VerifiedAccount> {
  try {
    const payload: any = { billersCode, serviceID };
    if (type) payload.type = type; // prepaid / postpaid

    const res = await fetch(`${vtpassBaseUrl()}/merchant-verify`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    const content = data?.content;

    // VTpass signals failure inside content.error rather than an HTTP error code.
    if (!content || content.error || data?.code !== '000') {
      return {
        success: false,
        message: content?.error || data?.response_description || 'Could not verify that account. Please check the number and try again.',
      };
    }

    return {
      success: true,
      customer_name: content.Customer_Name || content.Customer_name || undefined,
      customer_address: content.Address || content.Customer_Address || undefined,
      min_amount: content.Min_Purchase_Amount ? Number(content.Min_Purchase_Amount) : undefined,
      max_amount: content.Max_Purchase_Amount ? Number(content.Max_Purchase_Amount) : undefined,
    };
  } catch (err) {
    console.error('[DeAI] verifyAccount failed:', err);
    return { success: false, message: 'Verification service is unavailable right now. Please try again shortly.' };
  }
}

export interface DataPlan {
  name: string;
  price: number;
  code: string;
}

/**
 * REAL data bundle plans from VTpass, for the given serviceID (e.g. "mtn-data").
 */
export async function fetchDataVariations(serviceID: string): Promise<DataPlan[]> {
  try {
    const res = await fetch(`${vtpassBaseUrl()}/service-variations?serviceID=${encodeURIComponent(serviceID)}`, {
      method: 'GET',
      headers: getHeaders(),
    });

    const data = await res.json();
    const variations = data?.content?.variations;
    if (!Array.isArray(variations)) return [];

    return variations
      .map((v: any) => ({
        name: v.name,
        price: Number(v.variation_amount),
        code: v.variation_code,
      }))
      .filter((v: DataPlan) => v.name && Number.isFinite(v.price) && v.code);
  } catch (err) {
    console.error('[DeAI] fetchDataVariations failed:', err);
    return [];
  }
}

export interface CryptoBalances {
  [symbol: string]: string; // formatted, e.g. { "USD₮": "12.4300", "cUSD": "3.0000" }
}

/**
 * REAL on-chain stablecoin balances for a wallet, read from the same chain/RPC the app uses.
 */
export async function fetchCryptoBalances(walletAddress: string, blockchain = 'CELO'): Promise<CryptoBalances> {
  const empty: CryptoBalances = {};
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) return empty;

  try {
    const client = getPublicClient(blockchain);
    const isMainnet = isMainnetEnv();

    const chainKey = blockchain.toUpperCase() === 'BASE' ? 'base' : 'celo';
    const tokens = (SUPPORTED_TOKENS as any[]).filter(
      (t) => !t.supportedNetworks || t.supportedNetworks.includes(chainKey)
    );

    const balances: CryptoBalances = {};

    await Promise.all(
      tokens.map(async (t: any) => {
        const resolved = resolveTokenOnChain(t.symbol, blockchain, isMainnet);
        if (!resolved) return;
        try {
          const raw = (await client.readContract({
            address: resolved.address as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [walletAddress as `0x${string}`],
          })) as bigint;

          balances[t.symbol] = Number(formatUnits(raw, resolved.decimals)).toFixed(4);
        } catch {
          // A single token failing (e.g. not deployed on this network) must not break the rest.
          balances[t.symbol] = '0.0000';
        }
      })
    );

    return balances;
  } catch (err) {
    console.error('[DeAI] fetchCryptoBalances failed:', err);
    return empty;
  }
}

/**
 * Maps a parsed intent's provider + intent into the VTpass serviceID the app actually uses.
 */
export function resolveServiceId(intent: string, provider: string | null): string | null {
  if (!provider) return null;
  const p = provider.toLowerCase();

  switch (intent) {
    case 'VEND_AIRTIME':
      return p;                                   // mtn | airtel | glo | etisalat

    case 'VEND_DATA':
      // Providers already carrying a suffix (e.g. "smile-direct") are passed through.
      return p.includes('-') ? p : `${p}-data`;

    // The core uses 'ELECTRICITY'; the intent engine emits 'PAY_ELECTRICITY'. Accept both.
    case 'ELECTRICITY':
    case 'PAY_ELECTRICITY':
      return p.includes('electric') ? p : `${p}-electric`;

    // Same again: core uses 'TV', engine emits 'PAY_CABLE'.
    case 'TV':
    case 'PAY_CABLE':
      return p;                                   // dstv | gotv | startimes | showmax

    case 'INTERNET':
      return p;                                   // smile-direct | spectranet

    case 'EDUCATION':
      return p;                                   // waec | jamb | neco

    case 'BANK_TRANSFER':
      return 'bank-deposit';

    default:
      return null;
  }
}
