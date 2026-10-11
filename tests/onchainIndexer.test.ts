import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, pad, toHex } from 'viem';
import { toDataSuffix } from '@celo/attribution-tags';
import { decodePayments, indexChain, tagsFromInput, type IndexerRpc, type IndexerStore, type OnchainPaymentRow, type RpcLog } from '../src/lib/onchain/indexer';
import { AGENT_PAYMENT_TOPIC, ONCHAIN_CHAINS, PAYMENT_RECEIVED_TOPIC, TRANSFER_TOPIC } from '../src/lib/onchain/config';

const V4 = ONCHAIN_CHAINS.CELO.vaults[0].address.toLowerCase();
const V3 = ONCHAIN_CHAINS.CELO.vaults[1].address.toLowerCase();
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c';
const USDM = '0x765de816845861e75a25fca122bb6898b8b1282a';
const USER = '0x1111111111111111111111111111111111111111';
const FACILITATED = '0x2222222222222222222222222222222222222222';
const topic = (a: string) => pad(a as `0x${string}`, { size: 32 }).toLowerCase();
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function paymentReceived(txHash: string, block: number, logIndex: number, amount: bigint, token = USDC, vault = V4): RpcLog {
  return {
    address: vault,
    topics: [PAYMENT_RECEIVED_TOPIC, topic(USER), topic(token)],
    data: encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'uint256' }], ['AIRTIME', '08012345678', amount]),
    blockNumber: toHex(block),
    transactionHash: txHash,
    logIndex: toHex(logIndex),
  };
}
const agentPayment = (txHash: string, block: number, logIndex: number): RpcLog => ({
  address: V4, topics: [AGENT_PAYMENT_TOPIC], data: '0x', blockNumber: toHex(block), transactionHash: txHash, logIndex: toHex(logIndex),
});
const transfer = (txHash: string, block: number, logIndex: number, from: string, to: string, amount: bigint, token = USDC): RpcLog => ({
  address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: toHex(amount, { size: 32 }), blockNumber: toHex(block), transactionHash: txHash, logIndex: toHex(logIndex),
});

describe('decodePayments', () => {
  const times = new Map([[100n, 1_790_000_000], [101n, 1_790_000_060]]);

  it('classifies direct, agent and x402 payments, and never double-counts a contract payment', () => {
    const logs = [
      // direct payBill: PaymentReceived plus the transferFrom it performs
      transfer(tx(1), 100, 0, USER, V4, 2_500_000n),
      paymentReceived(tx(1), 100, 1, 2_500_000n),
      // relayer payBillFor: PaymentReceived plus AgentPayment
      transfer(tx(2), 100, 2, USER, V4, 1_000_000n),
      paymentReceived(tx(2), 100, 3, 1_000_000n),
      agentPayment(tx(2), 100, 4),
      // x402: a bare transfer into the vault
      transfer(tx(3), 101, 0, FACILITATED, V4, 80_000n),
    ];
    const rows = decodePayments('CELO', logs, times, new Map([[tx(1), ['celo_2719403c6aff', 'celo_9d71588659ec']]]));

    expect(rows.map((r) => [r.tx_hash, r.rail, r.amount_usd])).toEqual([
      [tx(1), 'direct', 2.5],
      [tx(2), 'agent', 1],
      [tx(3), 'x402', 0.08],
    ]);
    expect(rows[0]).toMatchObject({ payer: USER, service_type: 'AIRTIME', token_symbol: 'USDC', contract: V4, tags: ['celo_2719403c6aff', 'celo_9d71588659ec'] });
    expect(rows[2]).toMatchObject({ payer: FACILITATED, tags: [], block_time: new Date(1_790_000_060_000).toISOString() });
  });

  it('never stores the account number (customer PII)', () => {
    const rows = decodePayments('CELO', [paymentReceived(tx(4), 100, 0, 1_000_000n)], times, new Map());
    expect(JSON.stringify(rows)).not.toContain('08012345678');
  });

  it('reads the 18-decimal legacy USDm at 18 decimals', () => {
    const rows = decodePayments('CELO', [paymentReceived(tx(5), 100, 0, 3n * 10n ** 18n, USDM)], times, new Map());
    expect(rows[0]).toMatchObject({ token_symbol: 'USDm', amount_usd: 3 });
  });

  it('ignores vault-to-vault moves and tokens AbaPay never accepted', () => {
    const rows = decodePayments('CELO', [
      transfer(tx(6), 100, 0, V3, V4, 5_000_000n),
      transfer(tx(7), 100, 1, USER, V4, 5_000_000n, '0x9999999999999999999999999999999999999999'),
    ], times, new Map());
    expect(rows).toEqual([]);
  });
});

describe('tagsFromInput', () => {
  it('reads every ERC-8021 code on the calldata', () => {
    const suffix = toDataSuffix(['celo_2719403c6aff', 'celo_9d71588659ec']);
    expect(tagsFromInput(`0x760b4da7${'00'.repeat(64)}${suffix.slice(2)}`)).toEqual(['celo_2719403c6aff', 'celo_9d71588659ec']);
  });
  it('returns [] for untagged calldata', () => {
    expect(tagsFromInput(`0x760b4da7${'00'.repeat(64)}`)).toEqual([]);
  });
});

describe('indexChain', () => {
  const start = ONCHAIN_CHAINS.BASE.vaults.reduce((m, v) => (v.startBlock < m ? v.startBlock : m), ONCHAIN_CHAINS.BASE.vaults[0].startBlock);
  const BASE_V4 = ONCHAIN_CHAINS.BASE.vaults[0].address.toLowerCase();
  const BASE_USDC = ONCHAIN_CHAINS.BASE.tokens[0].address;

  function memoryStore(cursor: bigint | null = null) {
    const saved: OnchainPaymentRow[] = [];
    const state = { cursor, head: null as bigint | null };
    const store: IndexerStore = {
      getCursor: async () => state.cursor,
      saveRows: async (rows) => { saved.push(...rows); },
      saveCursor: async (_c, last, head) => { state.cursor = last; state.head = head; },
    };
    return { store, saved, state };
  }

  function fakeRpc(head: bigint, maxRange: bigint, paymentBlock: bigint) {
    const ranges: [bigint, bigint][] = [];
    const rpc: IndexerRpc = {
      blockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock, address }) => {
        if (toBlock - fromBlock + 1n > maxRange) throw new Error('block range too large');
        if (address.includes(BASE_USDC)) ranges.push([fromBlock, toBlock]);
        if (!address.includes(BASE_USDC) || paymentBlock < fromBlock || paymentBlock > toBlock) return [];
        return [{ ...transfer(tx(9), Number(paymentBlock), 0, FACILITATED, BASE_V4, 1_000_000n, BASE_USDC) }];
      },
      blockTimestamp: async () => 1_790_000_000,
      txInput: async () => '0x',
    };
    return { rpc, ranges };
  }

  it('starts at the earliest vault deployment, halves a refused range, and catches up', async () => {
    const head = start + 25_000n + ONCHAIN_CHAINS.BASE.confirmations;
    const { rpc, ranges } = fakeRpc(head, 5_000n, start + 12_345n);
    const { store, saved, state } = memoryStore();

    const res = await indexChain('BASE', rpc, store, 60_000);

    expect(ranges[0][0]).toBe(start);
    expect(ranges.every(([a, b]) => b - a + 1n <= 5_000n)).toBe(true);
    expect(res).toMatchObject({ caughtUp: true, payments: 1, toBlock: (start + 25_000n).toString() });
    expect(saved[0]).toMatchObject({ chain: 'BASE', rail: 'x402', amount_usd: 1, contract: BASE_V4 });
    expect(state.cursor).toBe(start + 25_000n);
  });

  it('resumes from the cursor and stops when its time budget is spent', async () => {
    const head = start + 1_000_000n;
    const { rpc, ranges } = fakeRpc(head, 10_000n, 0n);
    const { store } = memoryStore(start + 500n);
    let clock = 0;
    const res = await indexChain('BASE', rpc, store, 3, () => clock++);

    expect(ranges[0][0]).toBe(start + 501n);
    expect(res.caughtUp).toBe(false);
  });

  it('gives up on a range the provider refuses even at 500 blocks', async () => {
    const { rpc } = fakeRpc(start + 100_000n, 100n, 0n);
    await expect(indexChain('BASE', rpc, memoryStore().store, 60_000)).rejects.toThrow(/range too large/);
  });
});
