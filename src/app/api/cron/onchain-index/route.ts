import 'server-only';
import { NextResponse } from 'next/server';
import { verifyCronRequest } from '@/utils/cronAuth';
import { isMainnetEnv } from '@/lib/chain';
import type { OnchainChain } from '@/lib/onchain/config';
import { runOnchainIndex } from '@/lib/jobs/onchainIndexRun';

// ⚡ ON-CHAIN INDEX — manual / fallback trigger. The every-15-minutes run happens on GitHub Actions
// (.github/workflows/background-jobs.yml → scripts/jobs/run.ts), not here: since 2026-11-18 this
// work no longer spends the Vercel project's Hobby Active CPU. The logic is shared
// (src/lib/jobs/onchainIndexRun.ts), so calling this route still does exactly the same thing.
//
// ?chain=CELO or ?chain=BASE limits a call to one chain.

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
  const out = await runOnchainIndex({ chains: param ? [param as OnchainChain] : undefined, budgetMs: TOTAL_BUDGET_MS });
  return NextResponse.json({ caughtUp: out.caughtUp, results: out.results, payers: out.payers }, { status: out.failed ? 502 : 200 });
}
