import Link from 'next/link';
import { ArrowLeft, Download, ExternalLink } from 'lucide-react';
import { ONCHAIN_CHAINS, HACKATHON_TAG, BUILDERS_TAG, type OnchainChain } from '@/lib/onchain/config';
import { getLatestPayments, getOnchainSummary, RAIL_LABEL } from '@/lib/onchain/stats';
import { AreaLine, StackedBars, fillDays, type Series } from './charts';

// /agents/stats (Celo) and /agents/stats/base: AbaPay's on-chain activity, read from its own
// index of the chain (src/lib/onchain/indexer.ts) rather than from Dune. Every figure is a count
// of payments INTO the AbaPay vaults, and every payment links to its transaction on the explorer.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf = new Intl.NumberFormat('en-US');
const n = (v: number | string) => Number(v) || 0;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

const RAIL_SERIES: Series[] = [
  { key: 'x402', name: 'x402', className: 'fill-emerald-500' },
  { key: 'agent', name: 'Agent (relayer)', className: 'fill-sky-500' },
  { key: 'direct', name: 'Direct (wallet)', className: 'fill-slate-400 dark:fill-slate-600' },
];
const RAIL_DOT: Record<string, string> = { x402: 'bg-emerald-500', agent: 'bg-sky-500', direct: 'bg-slate-400 dark:bg-slate-600' };
const WALLET_SERIES: Series[] = [
  { key: 'returning', name: 'Returning', className: 'fill-sky-500' },
  { key: 'new_wallets', name: 'New', className: 'fill-emerald-500' },
];
const TAG_NAMES: Record<string, string> = {
  [HACKATHON_TAG]: 'Celo Open Rails hackathon',
  [BUILDERS_TAG]: 'Celo Builders',
  bc_jcuz1f23: 'Base builder code',
};

const card = 'bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-7 mb-6';
const h3 = 'text-xs font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-4';
const link = 'text-emerald-600 dark:text-emerald-400 hover:underline';

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap gap-4 mt-3">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" className={s.className} /></svg>
          {s.name}
        </span>
      ))}
    </div>
  );
}

export default async function StatsView({ chain }: { chain: OnchainChain }) {
  const cfg = ONCHAIN_CHAINS[chain];
  const chainName = chain === 'CELO' ? 'Celo' : 'Base';
  const [summary, latest] = await Promise.all([getOnchainSummary(chain), getLatestPayments(chain)]);

  const header = (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>
      <div className="mb-6">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">On-chain activity</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          Every payment into an AbaPay vault on {chainName}, read directly from the chain by AbaPay&apos;s own indexer. Each one links to its transaction, and the full list downloads as CSV.
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
    </>
  );

  if (!summary || n(summary.totals.payments) === 0) {
    return (
      <>
        {header}
        <section className={card}>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {summary ? 'The indexer is still reading this chain’s history. Numbers appear here as soon as the first payments are indexed.' : 'The on-chain index can’t be reached right now. Please try again shortly.'}
          </p>
        </section>
      </>
    );
  }

  const t = summary.totals;
  const agentPct = n(t.volume_usd) > 0 ? (100 * n(t.agent_volume_usd)) / n(t.volume_usd) : 0;
  const cursor = summary.cursors.find((c) => c.chain === chain);

  const last90 = fillDays(summary.daily, 90, (day) => ({ day, direct: 0, agent: 0, x402: 0, wallets: 0, volume_usd: 0, new_wallets: 0 }));
  const days90 = last90.map((d) => d.day.slice(0, 10));
  const walletRows = last90.map((d) => ({ new_wallets: n(d.new_wallets), returning: Math.max(n(d.wallets) - n(d.new_wallets), 0) }));

  // Running volume total, all time.
  const allDays = summary.daily.map((d) => d.day.slice(0, 10));
  const cumulative = summary.daily.reduce<number[]>((acc, d) => [...acc, (acc.at(-1) ?? 0) + n(d.volume_usd)], []);

  const KPIS = [
    { v: nf.format(n(t.payments)), l: 'Payments' },
    { v: nf.format(n(t.wallets)), l: 'Unique wallets' },
    { v: usd.format(n(t.volume_usd)), l: 'Volume' },
    { v: `${agentPct.toFixed(1)}%`, l: 'Agent-native volume' },
  ];
  const tagged = summary.tags.find((g) => g.tag === HACKATHON_TAG);
  const LAST30 = [
    { v: nf.format(n(summary.last30.payments)), l: 'Payments, last 30 days' },
    { v: nf.format(n(summary.last30.wallets)), l: 'Wallets, last 30 days' },
    { v: usd.format(n(summary.last30.volume_usd)), l: 'Volume, last 30 days' },
    chain === 'CELO'
      ? { v: nf.format(tagged ? n(tagged.payments) : 0), l: 'Hackathon-tagged payments' }
      : { v: nf.format(summary.by_contract.length), l: 'Vault contracts' },
  ];

  return (
    <>
      {header}

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-slate-100 dark:bg-slate-800/60 rounded-[2rem] overflow-hidden border border-slate-100 dark:border-slate-800/60 mb-3">
        {[...KPIS, ...LAST30].map((s) => (
          <div key={s.l} className="bg-white dark:bg-[#111114] p-5 sm:p-6">
            <div className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">{s.v}</div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-1">{s.l}</div>
          </div>
        ))}
      </section>
      <p className="text-xs text-slate-400 dark:text-slate-500 mb-6 px-2">
        {cursor && <>Indexed to block {nf.format(cursor.last_block)}, updated {when(cursor.updated_at)}. </>}
        Agent-native is x402 plus agent-relayer volume, as a share of all volume.
      </p>

      <section className={card}>
        <h3 className={h3}>Payments per day, by rail (last 90 days)</h3>
        <StackedBars days={days90} rows={last90.map((d) => ({ x402: n(d.x402), agent: n(d.agent), direct: n(d.direct) }))} series={RAIL_SERIES} unit="Payments" />
        <Legend series={RAIL_SERIES} />
      </section>

      <div className="grid lg:grid-cols-2 gap-x-6">
        <section className={card}>
          <h3 className={h3}>Total volume over time</h3>
          <AreaLine days={allDays} values={cumulative} format={(v) => usd.format(v)} label="Cumulative volume" />
        </section>
        <section className={card}>
          <h3 className={h3}>Paying wallets per day (last 90 days)</h3>
          <StackedBars days={days90} rows={walletRows} series={WALLET_SERIES} unit="Wallets" />
          <Legend series={WALLET_SERIES} />
        </section>
      </div>

      <section className={card}>
        <h3 className={h3}>By rail</h3>
        <div className="grid sm:grid-cols-3 gap-4">
          {summary.by_rail.map((r) => (
            <div key={r.rail} className="flex items-start gap-2.5">
              <span className={`${RAIL_DOT[r.rail]} w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0`} />
              <div>
                <div className="text-sm font-black text-slate-900 dark:text-white">{RAIL_LABEL[r.rail]}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {usd.format(n(r.volume_usd))} · {nf.format(n(r.payments))} payments · {nf.format(n(r.wallets))} wallets
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={card}>
        <h3 className={h3}>Vault contracts</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                <th className="pb-2 pr-4">Contract</th><th className="pb-2 pr-4">Payments</th><th className="pb-2 pr-4">Wallets</th><th className="pb-2 pr-4">Volume</th><th className="pb-2">Last payment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-slate-600 dark:text-slate-300">
              {summary.by_contract.map((c) => (
                <tr key={c.contract}>
                  <td className="py-2.5 pr-4">
                    <div className="font-bold text-slate-900 dark:text-white">{c.contract_label}</div>
                    <a href={`${cfg.explorer}/address/${c.contract}`} target="_blank" rel="noopener noreferrer" className={`${link} font-mono text-xs`}>{short(c.contract)}</a>
                  </td>
                  <td className="py-2.5 pr-4">{nf.format(n(c.payments))}</td>
                  <td className="py-2.5 pr-4">{nf.format(n(c.wallets))}</td>
                  <td className="py-2.5 pr-4">{usd.format(n(c.volume_usd))}</td>
                  <td className="py-2.5 whitespace-nowrap">{when(c.last_payment)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid lg:grid-cols-2 gap-x-6">
        <section className={card}>
          <h3 className={h3}>By token</h3>
          <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            {summary.by_token.map((k) => (
              <li key={k.token_symbol} className="flex justify-between gap-4">
                <span className="font-bold text-slate-900 dark:text-white">{k.token_symbol}</span>
                <span>{usd.format(n(k.volume_usd))} · {nf.format(n(k.payments))} payments</span>
              </li>
            ))}
          </ul>
        </section>
        <section className={card}>
          <h3 className={h3}>Attribution tags on contract payments</h3>
          {summary.tags.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No tagged payments indexed yet.</p>
          ) : (
            <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
              {summary.tags.map((g) => (
                <li key={g.tag} className="flex justify-between gap-4">
                  <span><code className="text-xs">{g.tag}</code> <span className="text-slate-400 dark:text-slate-500">{TAG_NAMES[g.tag] ?? ''}</span></span>
                  <span className="whitespace-nowrap">{nf.format(n(g.payments))}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">x402 payments carry no tag: the x402 facilitator submits those transactions, not AbaPay.</p>
        </section>
      </div>

      <section className={card}>
        <div className="flex items-center justify-between gap-4 mb-4">
          <h3 className={`${h3} mb-0`}>Latest payments</h3>
          <a href={`/api/onchain/export?chain=${chain}`} className={`${link} inline-flex items-center gap-1.5 text-xs font-bold`}>
            <Download size={14} /> Download all as CSV
          </a>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                <th className="pb-2 pr-4">Time</th><th className="pb-2 pr-4">Rail</th><th className="pb-2 pr-4">Amount</th><th className="pb-2 pr-4">Payer</th><th className="pb-2">Transaction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-slate-600 dark:text-slate-300">
              {latest.map((p) => (
                <tr key={`${p.tx_hash}-${p.log_index}`}>
                  <td className="py-2 pr-4 whitespace-nowrap">{when(p.block_time)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{RAIL_LABEL[p.rail]}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{usd2.format(n(p.amount_usd))} {p.token_symbol}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    <a href={`${cfg.explorer}/address/${p.payer}`} target="_blank" rel="noopener noreferrer" className={link}>{short(p.payer)}</a>
                  </td>
                  <td className="py-2 font-mono text-xs">
                    <a href={`${cfg.explorer}/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer" className={`${link} inline-flex items-center gap-1`}>{short(p.tx_hash)} <ExternalLink size={11} /></a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-slate-400 dark:text-slate-500 mb-14 px-2 max-w-3xl leading-relaxed">
        How it&apos;s counted: a contract payment is one <code>PaymentReceived</code> event (the agent rail when the same transaction also emitted <code>AgentPayment</code>); any other stablecoin transfer into a vault is an x402 payment. There is no minimum amount: this is what the chain recorded, including payments later refunded. The definitions are in{' '}
        <a href="https://github.com/investorphem/AbaPay/blob/main/src/lib/onchain/indexer.ts" target="_blank" rel="noopener noreferrer" className={link}>src/lib/onchain/indexer.ts</a>.
      </p>
    </>
  );
}
