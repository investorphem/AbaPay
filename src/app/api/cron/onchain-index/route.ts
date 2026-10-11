import 'server-only';
import { NextResponse } from 'next/server';
import { verifyCronRequest } from '@/utils/cronAuth';
import { isMainnetEnv } from '@/lib/chain';
import { indexChain, type IndexResult } from '@/lib/onchain/indexer';
import { indexerRpc, supabaseIndexerStore } from '@/lib/onchain/runtime';
import type { OnchainChain } from '@/lib/onchain/config';

// ⚡ ON-CHAIN INDEX — reads new vault payments from each chain into onchain_payments.
//
// Called every 15 minutes by .github/workflows/onchain-index.yml. Each call indexes from where the
// last one stopped and returns `caughtUp`; the very first run has months of history to read, so
// the workflow's manual "backfill" mode keeps calling until every chain reports caughtUp.
//
// ?chain=CELO or ?chain=BASE limits a call to one chain. Without it, Celo goes first (it is the
// chain the agents site reports on) and Base gets whatever time is left.

export const maxDuration = 300;

const TOTAL_BUDGET_MS = 250_000;

export async function POST(req: Request) {
  const denied = verifyCronRequest(req);
  if (denied) return denied;

  // The index reports mainnet activity only. A preview deployment (testnet) has nothing to add.
  if (!isMainnetEnv()) return NextResponse.json({ skipped: 'not a mainnet deployment' });

  const param = new URL(req.url).searchParams.get('chain')?.toUpperCase();
  if (param && param !== 'CELO' && param !== 'BASE') {
    return NextResponse.json({ error: 'chain must be CELO or BASE' }, { status: 400 });
  }
  const chains: OnchainChain[] = param ? [param as OnchainChain] : ['CELO', 'BASE'];

  const started = Date.now();
  const results: (IndexResult | { chain: OnchainChain; error: string })[] = [];
  for (const [i, chain] of chains.entries()) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    // Split what's left evenly across the chains still to go, so a long Celo backfill can't
    // starve Base of every run.
    const budget = Math.floor(left / (chains.length - i));
    try {
      results.push(await indexChain(chain, indexerRpc(chain), supabaseIndexerStore, budget));
    } catch (err) {
      console.error(`[onchain-index] ${chain} failed:`, err);
      results.push({ chain, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const failed = results.some((r) => 'error' in r);
  const caughtUp = results.every((r) => 'caughtUp' in r && r.caughtUp);
  return NextResponse.json({ caughtUp, results }, { status: failed ? 502 : 200 });
}
