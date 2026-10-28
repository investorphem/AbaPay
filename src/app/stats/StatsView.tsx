import { ONCHAIN_CHAINS, type OnchainChain } from '@/lib/onchain/config';
import { getLatestPayments, getOnchainSummary, getOnchainWindows, type OnchainSummary, type OnchainWindows } from '@/lib/onchain/stats';
import Dashboard from './Dashboard';

// The three pages of stats.abapays.com: the overview (both chains, chain = null), Celo and Base.
// Data comes from AbaPay's own index of the chain (src/lib/onchain/indexer.ts); this server half
// reads it, and Dashboard.tsx draws the interactive panels.

const NAME: Record<OnchainChain, string> = { CELO: 'Celo', BASE: 'Base' };

// Without onchain_windows() (migration 041 not applied, or the call failed) the page still works:
// the all-time window is rebuilt from onchain_summary(), and the counters stay all-time.
function allTimeOnly(s: OnchainSummary): Partial<OnchainWindows['windows']> {
  const byChain = (['CELO', 'BASE'] as const)
    .map((c) => {
      const rows = s.by_contract.filter((r) => r.chain === c);
      return { chain: c, payments: rows.reduce((t, r) => t + Number(r.payments), 0), volume_usd: rows.reduce((t, r) => t + Number(r.volume_usd), 0) };
    })
    .filter((c) => c.payments > 0);
  return {
    all: {
      payments: s.totals.payments, wallets: s.totals.wallets, new_wallets: s.totals.wallets,
      volume_usd: s.totals.volume_usd, agent_volume_usd: s.totals.agent_volume_usd,
      by_rail: s.by_rail, by_token: s.by_token, by_chain: byChain, tags: s.tags,
    },
  };
}

export default async function StatsView({ chain }: { chain: OnchainChain | null }) {
  const scope = chain ? NAME[chain] : 'Celo and Base';
  const [summary, windows, latest] = await Promise.all([getOnchainSummary(chain), getOnchainWindows(chain), getLatestPayments(chain)]);
  const cursors = summary?.cursors ?? [];
  const newest = cursors.map((c) => c.updated_at).sort().at(-1) ?? summary?.totals.last_payment ?? null;
  const vaults = (chain ? [chain] : (['CELO', 'BASE'] as const)).flatMap((c) =>
    ONCHAIN_CHAINS[c].vaults.map((v) => ({ ...v, chain: c, explorer: ONCHAIN_CHAINS[c].explorer })),
  );

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-3 text-balance">
          {chain ? `AbaPay on ${scope}` : 'AbaPay on-chain activity'}
        </h1>
        <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-3xl">
          Every payment into an AbaPay vault on {scope}, read directly from the chain by AbaPay&apos;s own indexer. Each panel says what it counts; open &ldquo;How it&apos;s calculated&rdquo; for the exact rule.
        </p>
      </div>

      {!summary || Number(summary.totals.payments) === 0 ? (
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-3xl p-6 mb-8">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {summary ? 'The indexer is still reading the chain’s history. Numbers appear here as soon as the first payments are indexed.' : 'The on-chain index can’t be reached right now. Please try again shortly.'}
          </p>
        </section>
      ) : (
        <Dashboard
          d={{
            chainName: scope,
            overview: chain === null,
            explorers: { CELO: ONCHAIN_CHAINS.CELO.explorer, BASE: ONCHAIN_CHAINS.BASE.explorer },
            asOf: newest
              ? new Date(newest).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) + ' WAT'
              : '',
            indexedBlocks: cursors.map((c) => ({ chain: NAME[c.chain], block: Number(c.last_block) })),
            firstPayment: summary.totals.first_payment,
            windows: windows?.windows ?? allTimeOnly(summary),
            active: windows?.active ?? [],
            daily: summary.daily,
            latest,
            csvHref: `/api/onchain/export?chain=${chain ?? 'ALL'}`,
          }}
        />
      )}

      <p className="text-xs text-slate-400 dark:text-slate-500 px-2 max-w-3xl leading-relaxed">
        Indexed vaults:{' '}
        {vaults.map((v, i) => (
          <span key={v.address}>
            {i > 0 && ', '}
            <a href={`${v.explorer}/address/${v.address}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">
              {chain ? v.label : `${NAME[v.chain]} ${v.label}`}
            </a>
          </span>
        ))}
        . No minimum amount: this is what the chain recorded, including payments later refunded. Updated every 15 minutes.
      </p>
    </>
  );
}
