// Deterministic chain fakes for payment-verification tests.
//
// Logs are ENCODED with the real PaymentReceived ABI (not hand-written hex), so the code under
// test decodes exactly what a live vault emits. The fake client answers only the two receipt
// calls src/lib/paymentProof.ts makes.

import { encodeAbiParameters, encodeEventTopics, parseUnits } from 'viem';
import { ABAPAY_CONTRACT_ABI_EVENTS } from '@/constants';

export const CELO_VAULT = '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c';
export const BASE_VAULT = '0xc0a4daa04ded9c54d1239507b5a5e645761ef488';
export const OTHER_CONTRACT = '0x1111111111111111111111111111111111111111';

// Celo mainnet token addresses (lowercase), matching SUPPORTED_TOKENS in src/constants.
export const CELO_TOKENS = {
  USDm: { address: '0x765de816845861e75a25fca122bb6898b8b1282a', decimals: 18 },
  USDC: { address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', decimals: 6 },
  'USD₮': { address: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', decimals: 6 },
} as const;

export const PAYER = '0x2222222222222222222222222222222222222222';

export function hash(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

export function paymentReceivedLog(p: {
  emitter?: string;
  user?: string;
  token: string;
  serviceType: string;
  accountNumber: string;
  amountWei: bigint;
  logIndex?: number;
}) {
  const topics = encodeEventTopics({
    abi: ABAPAY_CONTRACT_ABI_EVENTS as any,
    eventName: 'PaymentReceived',
    args: { user: (p.user ?? PAYER) as `0x${string}`, token: p.token as `0x${string}` },
  });
  const data = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
    [p.serviceType, p.accountNumber, p.amountWei],
  );
  return { address: p.emitter ?? CELO_VAULT, topics, data, logIndex: p.logIndex ?? 0 };
}

/** Convenience: a USDC/USD₮/USDm payment of `amount` whole tokens on Celo. */
export function celoPayment(symbol: keyof typeof CELO_TOKENS, amount: string, serviceType: string, accountNumber: string, extra: Partial<Parameters<typeof paymentReceivedLog>[0]> = {}) {
  const t = CELO_TOKENS[symbol];
  return paymentReceivedLog({ token: t.address, serviceType, accountNumber, amountWei: parseUnits(amount, t.decimals), ...extra });
}

const ERC20_TRANSFER = [{
  type: 'event', name: 'Transfer',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;

/** An ERC-20 Transfer log, emitted by `token` (what an x402 facilitator settlement produces). */
export function transferLog(p: { token: string; from: string; to: string; value: bigint; logIndex?: number }) {
  const topics = encodeEventTopics({ abi: ERC20_TRANSFER, eventName: 'Transfer', args: { from: p.from as `0x${string}`, to: p.to as `0x${string}` } });
  const data = encodeAbiParameters([{ type: 'uint256' }], [p.value]);
  return { address: p.token, topics, data, logIndex: p.logIndex ?? 0 };
}

export type FakeReceipt = { status: 'success' | 'reverted'; logs: any[]; blockNumber?: bigint };

/**
 * `authStates` answers EIP-3009 `authorizationState(payer, nonce)` by lowercased nonce:
 * true = spent, false = unspent, an Error = unreadable. Missing nonces read as unspent.
 */
export function fakeClient(receipts: Record<string, FakeReceipt | Error>, authStates: Record<string, boolean | Error> = {}) {
  const lookup = (h: string) => {
    const r = receipts[h.toLowerCase()];
    if (r instanceof Error) throw r;
    if (!r) {
      const e = new Error('receipt not found');
      e.name = 'TransactionReceiptNotFoundError';
      throw e;
    }
    return { blockNumber: BigInt(1), ...r };
  };
  return {
    getTransactionReceipt: async ({ hash }: { hash: string }) => lookup(hash),
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => lookup(hash),
    // The x402 route's pre-settlement signature check: a plain EOA, and a simulation the token accepts.
    getCode: async () => '0x',
    simulateContract: async () => ({ result: undefined }),
    readContract: async ({ functionName, args }: { functionName: string; args: any[] }) => {
      if (functionName !== 'authorizationState') throw new Error(`fakeClient: readContract(${functionName}) not modelled`);
      const s = authStates[String(args[1]).toLowerCase()];
      if (s instanceof Error) throw s;
      return s ?? false;
    },
  } as any;
}
