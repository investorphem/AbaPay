import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ONCHAIN_CHAINS, HACKATHON_TAG, type OnchainChain } from '@/lib/onchain/config';
import { getLatestPayments, getOnchainSummary } from '@/lib/onchain/stats';
import Dashboard from './Dashboard';

// /agents/stats (Celo) and /agents/stats/base: AbaPay's on-chain activity, read from its own
// index of the chain (src/lib/onchain/indexer.ts) rather than from Dune. This server half reads
// the data; Dashboard.tsx draws the interactive panels.

export default async function StatsView({ chain }: { chain: OnchainChain }) {
  const cfg = ONCHAIN_CHAINS[chain];
  const chainName = chain === 'CELO' ? 'Celo' : 'Base';
  const [summary, latest] = await Promise.all([getOnchainSummary(chain), getLatestPayments(chain)]);
  const cursor = summary?.cursors.find((c) => c.chain === chain);

  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">AbaPay on {chainName}: on-chain activity</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          Every payment into an AbaPay vault on {chainName}, read directly from the chain by AbaPay&apos;s own indexer. Each panel says what it counts; open &ldquo;How it&apos;s calculated&rdquo; for the exact rule.
        </p>
      </div>
      <div className="flex gap-2 mb-6">
        {(['CELO', 'BASE'] as const).map((c) => (
          <Link
            key={c}
            href={c === 'CELO' ? '/agents/stats' : '/agents/stats/base'}
            className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest border ${c === chain ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white' : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:text-emerald-600'}`}
          >
            {c === 'CELO' ? 'Celo' : 'Base'}
          </Link>
        ))}
      </div>

      {!summary || Number(summary.totals.payments) === 0 ? (
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-3xl p-6 mb-14">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {summary ? 'The indexer is still reading this chain’s history. Numbers appear here as soon as the first payments are indexed.' : 'The on-chain index can’t be reached right now. Please try again shortly.'}
          </p>
        </section>
      ) : (
        <Dashboard
          d={{
            chainName,
            explorer: cfg.explorer,
            asOf: new Date(cursor?.updated_at ?? summary.totals.last_payment ?? 0).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC',
            indexedBlock: cursor ? Number(cursor.last_block) : null,
            totals: summary.totals,
            last30: summary.last30,
            byRail: summary.by_rail,
            byToken: summary.by_token,
            byService: summary.by_service ?? [],
            tags: summary.tags,
            daily: summary.daily,
            latest,
            hackathonTag: chain === 'CELO' ? HACKATHON_TAG : null,
            csvHref: `/api/onchain/export?chain=${chain}`,
          }}
        />
      )}

      <p className="text-xs text-slate-400 dark:text-slate-500 mb-14 px-2 max-w-3xl leading-relaxed">
        Indexed vaults on {chainName}:{' '}
        {cfg.vaults.map((v, i) => (
          <span key={v.address}>
            {i > 0 && ', '}
            <a href={`${cfg.explorer}/address/${v.address}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">{v.label}</a>
          </span>
        ))}
        . No minimum amount: this is what the chain recorded, including payments later refunded. Source:{' '}
        <a href="https://github.com/investorphem/AbaPay/blob/main/src/lib/onchain/indexer.ts" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">src/lib/onchain/indexer.ts</a>.
      </p>
    </>
  );
}
