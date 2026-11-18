import 'server-only';
import { pingDeadman } from '@/lib/deadman';
import { indexChain, type IndexResult } from '@/lib/onchain/indexer';
import { indexerRpc, supabaseIndexerStore } from '@/lib/onchain/runtime';
import type { OnchainChain } from '@/lib/onchain/config';
import { recheckAgentPayers, type RecheckResult } from '@/lib/onchain/payerRecheck';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ ON-CHAIN INDEX — reads new vault payments from each chain into onchain_payments, then re-checks
// a batch of agent payers. Shared by /api/cron/onchain-index (manual calls) and the GitHub Actions
// job runner (scripts/jobs/run.ts), which is what runs it every 15 minutes since 2026-11-18: Vercel
// paused the project for exceeding the Hobby plan's Active CPU, and this work runs all day.
//
// `chains` limits a run to one chain. Without it, Base goes first: once caught up it needs a few
// seconds a run, so Celo (the chain the agents site reports on) gets nearly the whole budget.

export type OnchainIndexOutcome = {
  caughtUp: boolean;
  failed: boolean;
  results: (IndexResult | { chain: OnchainChain; error: string })[];
  payers?: RecheckResult | { error: string };
};

export async function runOnchainIndex(opts: { chains?: OnchainChain[]; budgetMs: number }): Promise<OnchainIndexOutcome> {
  const chains = opts.chains ?? ['BASE', 'CELO'];
  const started = Date.now();
  const results: OnchainIndexOutcome['results'] = [];
  for (const [i, chain] of chains.entries()) {
    const left = opts.budgetMs - (Date.now() - started);
    // Split what's left evenly across the chains still to go, so a long backfill on one chain
    // can't starve the other of every run.
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
  // HEALTHCHECK_URL_ONCHAIN: pages someone if the index stops being fed (src/lib/deadman.ts).
  await pingDeadman('ONCHAIN', !failed);

  // With the index caught up, re-read a batch of x402/relayer payer wallets from the chain, so a
  // wallet that registered as an agent after paying is named (src/lib/onchain/payerRecheck.ts).
  // Never fails the run: the index is what the deadman watches.
  let payers: OnchainIndexOutcome['payers'];
  const left = opts.budgetMs - (Date.now() - started);
  if (caughtUp && !opts.chains && left > 30_000) {
    try {
      payers = await recheckAgentPayers({ deadline: Date.now() + left - 10_000 });
      if (payers.newly_identified.length) {
        await sendTelegramAlert(`🪪 *Agent payer identified on chain*\n${payers.newly_identified.length} wallet(s) that paid through x402/the relayer now have an ERC-8004 or Self identity:\n${payers.newly_identified.map((w) => `\`${w}\``).join('\n')}`).catch(() => {});
      }
    } catch (err) {
      console.error('[onchain-index] payer re-check failed:', err);
      payers = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { caughtUp, failed, results, payers };
}
