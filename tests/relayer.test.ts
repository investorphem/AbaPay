import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';

// ⚡ THE AGENT'S ON-CHAIN PER-PAYMENT CAP (ABAPAY_FULL_AUDIT.md P-10).
//
// The vault caps a single agent payment (maxAgentPaymentPerTx). A payment above it must be
// refused BEFORE the relayer broadcasts — the contract would revert it with
// ExceedsMaxAgentPayment after the relayer had already paid the gas.

vi.mock('server-only', () => ({}));

let allowanceRaw = BigInt(0);
let capRaw: bigint | Error = BigInt(0);
const writeContract = vi.fn(async () => '0x' + 'b'.repeat(64));

vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {} }));
vi.mock('@/lib/attribution', () => ({ celoAttributionSuffix: () => undefined, baseAttributionSuffix: () => undefined }));
vi.mock('@/lib/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chain')>();
  return {
    ...actual,
    getPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'remainingAllowance') return allowanceRaw;
        if (functionName === 'maxAgentPaymentPerTx') { if (capRaw instanceof Error) throw capRaw; return capRaw; }
        throw new Error(`unexpected read ${functionName}`);
      },
    }),
  };
});
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: () => ({
      extend: () => ({ writeContract, waitForTransactionReceipt: async () => ({ status: 'success' }) }),
    }),
  };
});

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK = 'celo';
  process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c';
  process.env.RELAYER_PRIVATE_KEY = generatePrivateKey(); // throwaway key for the test process
});

const { relayPayBillFor, getMaxAgentPayment } = await import('@/lib/deai/relayer');

const pay = (amountCrypto: string, tokenSymbol = 'USDC') => relayPayBillFor({
  userWallet: '0x2222222222222222222222222222222222222222', tokenSymbol,
  serviceType: 'ikeja-electric', accountNumber: '1234567890', amountCrypto, blockchain: 'CELO', sourceChannel: 'MCP',
});

beforeEach(() => {
  allowanceRaw = BigInt(1_000_000_000); // 1,000 USDC approved
  writeContract.mockClear();
});

describe('relayPayBillFor — on-chain per-payment cap', () => {
  it('refuses a payment above the vault cap without broadcasting', async () => {
    capRaw = BigInt(10_000_000); // 10 USDC
    const r = await pay('14.9254'); // ≈ ₦20,000
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/10 USDC per-payment limit/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('broadcasts a payment within the cap', async () => {
    capRaw = BigInt(10_000_000);
    const r = await pay('7.4627');
    expect(r.success).toBe(true);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('says so plainly when agent payments in that token are off on-chain (cap 0)', async () => {
    capRaw = BigInt(0);
    const r = await pay('1', 'USD₮');
    expect(r.message).toMatch(/switched off on-chain/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('lets the contract decide when the cap cannot be read', async () => {
    capRaw = new Error('rpc down');
    const r = await pay('7', 'USA₮');
    expect(r.success).toBe(true);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('reports the cap in human units (6-decimal token)', async () => {
    capRaw = BigInt(25_000_000);
    // USA₮ on Celo: its cap was unreadable above, so nothing is cached for it yet.
    expect(await getMaxAgentPayment('USA₮', 'CELO')).toBe(25);
  });
});
