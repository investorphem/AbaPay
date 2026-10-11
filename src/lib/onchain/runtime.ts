import 'server-only';
import { createPublicClient, fallback, http } from 'viem';
import { rpcUrlsFor } from '@/lib/chain';
import { supabaseAdmin } from '@/utils/supabase';
import { ONCHAIN_CHAINS, type OnchainChain } from './config';
import type { IndexerRpc, IndexerStore, OnchainPaymentRow, RpcLog } from './indexer';

// The production wiring for src/lib/onchain/indexer.ts: the chain's RPC list (the private
// Chainstack endpoint first, then the public ones) and the onchain_payments tables.

export function indexerRpc(chain: OnchainChain): IndexerRpc {
  const urls = rpcUrlsFor(ONCHAIN_CHAINS[chain].chainId);
  // JSON-RPC batching: the indexer asks for block times and calldata 25 at a time, and this sends
  // each group as one HTTP request instead of 25.
  const client = createPublicClient({ transport: fallback(urls.map((u) => http(u, { batch: { batchSize: 25 } }))) });
  return {
    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    getLogs: async ({ fromBlock, toBlock, address, topics }) =>
      (await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, address, topics }],
      } as never)) as RpcLog[],
    blockTimestamp: async (block) => Number((await client.getBlock({ blockNumber: block })).timestamp),
    txInput: async (hash) => (await client.getTransaction({ hash: hash as `0x${string}` })).input,
  };
}

export const supabaseIndexerStore: IndexerStore = {
  async getCursor(chain) {
    const { data, error } = await supabaseAdmin.from('onchain_cursors').select('last_block').eq('chain', chain).maybeSingle();
    if (error) throw new Error(`onchain_cursors read failed: ${error.message}`);
    return data ? BigInt(data.last_block) : null;
  },
  async saveRows(rows: OnchainPaymentRow[]) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin
        .from('onchain_payments')
        .upsert(rows.slice(i, i + 500), { onConflict: 'chain,tx_hash,log_index' });
      if (error) throw new Error(`onchain_payments upsert failed: ${error.message}`);
    }
  },
  async saveCursor(chain, lastBlock, headBlock) {
    const { error } = await supabaseAdmin.from('onchain_cursors').upsert({
      chain,
      last_block: Number(lastBlock),
      head_block: Number(headBlock),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`onchain_cursors write failed: ${error.message}`);
  },
};
