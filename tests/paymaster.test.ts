import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';

// /api/paymaster only asks CDP to sponsor AbaPay's own calls (src/lib/paymasterPolicy.ts).

vi.mock('server-only', () => ({}));
const rateBuckets = new Map<string, number>();
vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: async () => null,
  enforceRateLimitByKey: async (key: string, limit: number) => {
    const n = (rateBuckets.get(key) || 0) + 1;
    rateBuckets.set(key, n);
    return n > limit ? new Response('{}', { status: 429 }) : null;
  },
}));

const VAULT = '0xc0a4daa04ded9c54d1239507b5a5e645761ef488';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SENDER = '0x1111111111111111111111111111111111111111';
const ATTACKER_TARGET = '0x2222222222222222222222222222222222222222';

process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS = VAULT;
process.env.NEXT_PUBLIC_NETWORK = 'mainnet';
process.env.PAYMASTER_URL = 'https://paymaster.example/rpc';

import { checkUserOperation } from '@/lib/paymasterPolicy';
import { POST } from '@/app/api/paymaster/route';

const WALLET = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const TOKEN = parseAbi(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)']);
const VAULT_ABI = parseAbi([
  'function payBill(address tokenAddress, string serviceType, string accountNumber, uint256 amount)',
  'function setSpendingAllowance(address tokenAddress, uint256 amount)',
  'function queueWithdrawal(address tokenAddress, uint256 amount)',
]);

const approve = (spender = VAULT) => ({ target: USDC, value: BigInt(0), data: encodeFunctionData({ abi: TOKEN, functionName: 'approve', args: [spender as `0x${string}`, BigInt(1_000_000)] }) });
// The app appends a builder-code suffix to payBill's calldata.
const payBill = () => ({ target: VAULT, value: BigInt(0), data: (encodeFunctionData({ abi: VAULT_ABI, functionName: 'payBill', args: [USDC, 'AIRTIME', '08012345678', BigInt(1_000_000)] }) + '62635f6a63757a3166323300') as `0x${string}` });
const batch = (calls: any[]) => encodeFunctionData({ abi: WALLET, functionName: 'executeBatch', args: [calls as any] });
const scope = { vault: VAULT, tokens: [USDC] };

describe('checkUserOperation', () => {
  it('sponsors approve(vault) + payBill in one batch', () => {
    expect(checkUserOperation({ callData: batch([approve(), payBill()]) }, scope)).toEqual({ ok: true });
  });

  it('sponsors a lone payBill via execute, and setSpendingAllowance', () => {
    const p = payBill();
    expect(checkUserOperation({ callData: encodeFunctionData({ abi: WALLET, functionName: 'execute', args: [p.target as `0x${string}`, BigInt(0), p.data] }) }, scope).ok).toBe(true);
    const set = encodeFunctionData({ abi: VAULT_ABI, functionName: 'setSpendingAllowance', args: [USDC, BigInt(0)] });
    expect(checkUserOperation({ callData: batch([{ target: VAULT, value: BigInt(0), data: set }]) }, scope).ok).toBe(true);
  });

  it('refuses an arbitrary target', () => {
    const r = checkUserOperation({ callData: batch([{ target: ATTACKER_TARGET, value: BigInt(0), data: '0x' }]) }, scope);
    expect(r.ok).toBe(false);
  });

  it('refuses a batch where one call is not allowed', () => {
    const transfer = { target: USDC, value: BigInt(0), data: encodeFunctionData({ abi: TOKEN, functionName: 'transfer', args: [ATTACKER_TARGET, BigInt(5)] }) };
    expect(checkUserOperation({ callData: batch([approve(), payBill(), transfer]) }, scope).ok).toBe(false);
  });

  it('refuses approve to anyone but the vault, other vault functions, and native value', () => {
    expect(checkUserOperation({ callData: batch([approve(ATTACKER_TARGET)]) }, scope).ok).toBe(false);
    const q = encodeFunctionData({ abi: VAULT_ABI, functionName: 'queueWithdrawal', args: [USDC, BigInt(1)] });
    expect(checkUserOperation({ callData: batch([{ target: VAULT, value: BigInt(0), data: q }]) }, scope).ok).toBe(false);
    expect(checkUserOperation({ callData: batch([{ ...payBill(), value: BigInt(1) }]) }, scope).ok).toBe(false);
  });

  it('refuses malformed callData', () => {
    expect(checkUserOperation({}, scope).ok).toBe(false);
    expect(checkUserOperation({ callData: '0xdeadbeef' }, scope).ok).toBe(false);
  });
});

describe('POST /api/paymaster', () => {
  let upstream: any[];
  beforeEach(() => {
    upstream = [];
    rateBuckets.clear();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      upstream.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { paymaster: '0x' } }), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const rpc = (callData: string, sender = SENDER, method = 'pm_getPaymasterStubData') => new Request('https://abapays.com/api/paymaster', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [{ sender, callData }, '0x0000000071727De22E5E9d8BAf0edAc6f37da032', '0x2105', {}] }),
  });

  it('forwards an AbaPay payment to CDP', async () => {
    const res = await POST(rpc(batch([approve(), payBill()])));
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
  });

  it('refuses anything else without contacting CDP', async () => {
    const res = await POST(rpc(batch([{ target: ATTACKER_TARGET, value: BigInt(0), data: '0x' }])));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe(-32602);
    expect(upstream).toHaveLength(0);
  });

  it('refuses a chain other than Base', async () => {
    const req = new Request('https://abapays.com/api/paymaster', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterData', params: [{ sender: SENDER, callData: batch([approve(), payBill()]) }, '0x0', '0x1', {}] }),
    });
    expect((await POST(req)).status).toBe(403);
    expect(upstream).toHaveLength(0);
  });

  it('rate-limits a single sender', async () => {
    for (let i = 0; i < 20; i++) expect((await POST(rpc(batch([approve(), payBill()])))).status).toBe(200);
    expect((await POST(rpc(batch([approve(), payBill()])))).status).toBe(429);
  });
});
