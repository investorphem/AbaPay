import { decodeAbiParameters, type Hex } from 'viem';
import { fromDataSuffix } from '@celo/attribution-tags';
import {
  AGENT_PAYMENT_TOPIC,
  ONCHAIN_CHAINS,
  PAYMENT_RECEIVED_TOPIC,
  TRANSFER_TOPIC,
  type OnchainChain,
} from './config';

// ⚡ AbaPay's own on-chain index, the replacement for Dune.
//
// Reads every payment into an AbaPay vault straight from the chain's RPC (Chainstack first, the
// public endpoints as fallback; see rpcUrlsFor) and stores one row per payment in
// onchain_payments. Two kinds of log are read per block range:
//
//   1. The vaults' own PaymentReceived and AgentPayment events: payBill / payBillFor calls.
//   2. Stablecoin Transfer events INTO a vault. Every contract payment produces one of these
//      too, so a transfer only counts as an x402 payment when its transaction has no
//      PaymentReceived. Counting both would double every contract payment.
//
// It is resumable: the cursor only moves past a range once that range's rows are saved, and rows
// are upserted on (chain, tx_hash, log_index), so a run that dies halfway re-reads the range and
// changes nothing. A run stops when its time budget is spent, and the next one carries on, which
// is how the first backfill of several months of history completes across a few runs.

export type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

/** The few RPC calls the indexer makes. Injected so tests can drive it without a node. */
export type IndexerRpc = {
  blockNumber(): Promise<bigint>;
  getLogs(filter: { fromBlock: bigint; toBlock: bigint; address: string[]; topics: (string | string[] | null)[] }): Promise<RpcLog[]>;
  blockTimestamp(block: bigint): Promise<number>;
  txInput(hash: string): Promise<string>;
};

export type OnchainPaymentRow = {
  chain: OnchainChain;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: string;
  contract: string;
  contract_label: string;
  payer: string;
  token_address: string;
  token_symbol: string;
  amount_usd: number;
  rail: 'direct' | 'agent' | 'x402';
  service_type: string | null;
  tags: string[];
};

export type IndexerStore = {
  getCursor(chain: OnchainChain): Promise<bigint | null>;
  saveRows(rows: OnchainPaymentRow[]): Promise<void>;
  saveCursor(chain: OnchainChain, lastBlock: bigint, headBlock: bigint): Promise<void>;
};

export type IndexResult = {
  chain: OnchainChain;
  fromBlock: string;
  toBlock: string;
  headBlock: string;
  payments: number;
  caughtUp: boolean;
};

const addrTopic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const topicAddr = (t: string) => `0x${t.slice(26).toLowerCase()}`;

/** ERC-8021 codes on a transaction's calldata, or [] when it carries none (or isn't decodable). */
export function tagsFromInput(input: string): string[] {
  try {
    return fromDataSuffix(input as Hex)?.codes ?? [];
  } catch {
    return [];
  }
}

/** Turns one block range's logs into payment rows. Pure: everything it needs is passed in. */
export function decodePayments(
  chain: OnchainChain,
  logs: RpcLog[],
  blockTimes: Map<bigint, number>,
  txTags: Map<string, string[]>,
): OnchainPaymentRow[] {
  const cfg = ONCHAIN_CHAINS[chain];
  const vaults = new Map(cfg.vaults.map((v) => [v.address.toLowerCase(), v.label]));
  const tokens = new Map(cfg.tokens.map((t) => [t.address.toLowerCase(), t]));

  const agentTxs = new Set<string>();
  const paymentTxs = new Set<string>();
  for (const l of logs) {
    const t0 = l.topics[0]?.toLowerCase();
    if (!vaults.has(l.address.toLowerCase())) continue;
    if (t0 === AGENT_PAYMENT_TOPIC) agentTxs.add(l.transactionHash.toLowerCase());
    if (t0 === PAYMENT_RECEIVED_TOPIC) paymentTxs.add(l.transactionHash.toLowerCase());
  }

  const rows: OnchainPaymentRow[] = [];
  for (const l of logs) {
    const t0 = l.topics[0]?.toLowerCase();
    const tx = l.transactionHash.toLowerCase();
    const block = BigInt(l.blockNumber);
    const time = blockTimes.get(block);
    if (time === undefined) continue;
    const base = {
      chain,
      tx_hash: tx,
      log_index: Number(BigInt(l.logIndex)),
      block_number: Number(block),
      block_time: new Date(time * 1000).toISOString(),
    };

    if (t0 === PAYMENT_RECEIVED_TOPIC && vaults.has(l.address.toLowerCase())) {
      const token = tokens.get(topicAddr(l.topics[2]));
      if (!token) continue; // a token AbaPay never accepted: its decimals are unknown, so skip it
      // (string serviceType, string accountNumber, uint256 amount). The account number is
      // customer PII and is deliberately dropped here.
      const [serviceType, , amount] = decodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
        l.data as Hex,
      );
      rows.push({
        ...base,
        contract: l.address.toLowerCase(),
        contract_label: vaults.get(l.address.toLowerCase())!,
        payer: topicAddr(l.topics[1]),
        token_address: token.address.toLowerCase(),
        token_symbol: token.symbol,
        amount_usd: Number(amount) / 10 ** token.decimals,
        rail: agentTxs.has(tx) ? 'agent' : 'direct',
        service_type: serviceType || null,
        tags: txTags.get(tx) ?? [],
      });
      continue;
    }

    if (t0 === TRANSFER_TOPIC && !paymentTxs.has(tx)) {
      const token = tokens.get(l.address.toLowerCase());
      const to = topicAddr(l.topics[2]);
      const from = topicAddr(l.topics[1]);
      if (!token || !vaults.has(to) || vaults.has(from)) continue;
      rows.push({
        ...base,
        contract: to,
        contract_label: vaults.get(to)!,
        payer: from,
        token_address: token.address.toLowerCase(),
        token_symbol: token.symbol,
        amount_usd: Number(BigInt(l.data)) / 10 ** token.decimals,
        rail: 'x402',
        service_type: null,
        tags: [],
      });
    }
  }
  return rows;
}

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * Indexes one chain from its cursor towards the head until done or `budgetMs` is spent.
 * Never throws for a refused range on its own: it halves the range first, and only gives up on a
 * range the provider refuses even at 500 blocks.
 */
export async function indexChain(
  chain: OnchainChain,
  rpc: IndexerRpc,
  store: IndexerStore,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<IndexResult> {
  const cfg = ONCHAIN_CHAINS[chain];
  const deadline = now() + budgetMs;
  const vaultAddrs = cfg.vaults.map((v) => v.address.toLowerCase());
  const tokenAddrs = cfg.tokens.map((t) => t.address.toLowerCase());
  const firstBlock = cfg.vaults.reduce((m, v) => (v.startBlock < m ? v.startBlock : m), cfg.vaults[0].startBlock);

  const cursor = await store.getCursor(chain);
  const start = cursor === null ? firstBlock : cursor + BigInt(1);
  const head = (await rpc.blockNumber()) - cfg.confirmations;

  let from = start;
  let range = cfg.maxRange;
  let saved = 0;
  while (from <= head && now() < deadline) {
    const to = from + range - BigInt(1) < head ? from + range - BigInt(1) : head;
    let logs: RpcLog[];
    try {
      const [own, transfers] = await Promise.all([
        rpc.getLogs({ fromBlock: from, toBlock: to, address: vaultAddrs, topics: [[PAYMENT_RECEIVED_TOPIC, AGENT_PAYMENT_TOPIC]] }),
        rpc.getLogs({ fromBlock: from, toBlock: to, address: tokenAddrs, topics: [TRANSFER_TOPIC, null, vaultAddrs.map(addrTopic)] }),
      ]);
      logs = [...own, ...transfers];
    } catch (err) {
      if (range > BigInt(500)) {
        range /= BigInt(2);
        continue;
      }
      throw err;
    }

    const blocks = [...new Set(logs.map((l) => BigInt(l.blockNumber)))];
    const times = await inChunks(blocks, 25, (b) => rpc.blockTimestamp(b));
    const blockTimes = new Map(blocks.map((b, i) => [b, times[i]]));

    // Only contract payments can carry AbaPay's attribution tags; x402 transactions are sent by
    // the facilitator. So only their calldata is fetched.
    const paymentTxs = [...new Set(logs.filter((l) => l.topics[0]?.toLowerCase() === PAYMENT_RECEIVED_TOPIC).map((l) => l.transactionHash.toLowerCase()))];
    const inputs = await inChunks(paymentTxs, 25, (h) => rpc.txInput(h));
    const txTags = new Map(paymentTxs.map((h, i) => [h, tagsFromInput(inputs[i])]));

    const rows = decodePayments(chain, logs, blockTimes, txTags);
    if (rows.length) await store.saveRows(rows);
    await store.saveCursor(chain, to, head);
    saved += rows.length;
    from = to + BigInt(1);
    if (range < cfg.maxRange) range *= BigInt(2); // a refusal is often one dense range; try wider again
  }

  return {
    chain,
    fromBlock: start.toString(),
    toBlock: (from - BigInt(1)).toString(),
    headBlock: head.toString(),
    payments: saved,
    caughtUp: from > head,
  };
}
