'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type LegendPayload,
} from 'recharts';
import { Check, Download, ExternalLink, Link2 } from 'lucide-react';

// The Dune-style dashboard on /agents/stats. Every panel is self-contained (title, description,
// "how it's calculated", chain and date in its footer), so a screenshot of any one panel still
// says what it shows and where it came from. Hover or tap a bar or slice for its exact values;
// click a legend entry to hide that series.

type Num = number | string;
type Rail = 'direct' | 'agent' | 'x402';

export type DashboardData = {
  chainName: string;
  explorer: string;
  asOf: string;
  indexedBlock: number | null;
  totals: { payments: Num; wallets: Num; volume_usd: Num; agent_volume_usd: Num; first_payment: string | null };
  last30: { payments: Num; wallets: Num; volume_usd: Num };
  byRail: { rail: Rail; payments: Num; wallets: Num; volume_usd: Num }[];
  byToken: { token_symbol: string; payments: Num; volume_usd: Num }[];
  byService: { service_type: string; payments: Num; volume_usd: Num }[];
  tags: { tag: string; payments: Num; last_payment: string }[];
  daily: {
    day: string;
    direct: Num; agent: Num; x402: Num;
    wallets: Num; new_wallets: Num; volume_usd: Num;
    volume_direct?: Num; volume_agent?: Num; volume_x402?: Num;
  }[];
  latest: { tx_hash: string; log_index: number; block_time: string; payer: string; token_symbol: string; amount_usd: Num; rail: Rail }[];
  hackathonTag: string | null;
  csvHref: string;
};

const n = (v: Num | undefined) => Number(v) || 0;
const nf = new Intl.NumberFormat('en-US');
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const usdCompact = (v: number) => `$${compact.format(v)}`;
const usdSmart = (v: number) => (Math.abs(v) < 100 ? usd2.format(v) : usd0.format(v));
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLong = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const RAILS: { key: Rail; name: string; color: string }[] = [
  { key: 'x402', name: 'x402', color: '#10b981' },
  { key: 'agent', name: 'Agent (relayer)', color: '#0ea5e9' },
  { key: 'direct', name: 'Direct (wallet)', color: '#94a3b8' },
];
const RAIL_NAME = Object.fromEntries(RAILS.map((r) => [r.key, r.name])) as Record<Rail, string>;
const PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#64748b', '#14b8a6', '#eab308'];

const RANGES = [
  { key: '30', label: '30D', days: 30 },
  { key: '90', label: '90D', days: 90 },
  { key: 'all', label: 'All', days: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/* ─── Panel chrome ─────────────────────────────────────────────────────────── */

function Panel({ id, title, description, how, footer, compact = false, className = '', action, children }: {
  id: string; title: string; description: string; how: ReactNode; footer: string;
  /** Counter tiles: too narrow for the site address, so the footer carries only brand, chain and date. */
  compact?: boolean;
  className?: string; action?: ReactNode; children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      location.hash = id;
    }
  };
  return (
    <section id={id} className={`min-w-0 scroll-mt-24 bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-3xl p-5 sm:p-6 flex flex-col ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 dark:text-white">{title}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{description}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {action}
          <button type="button" onClick={copy} aria-label={`Copy a link to "${title}"`} title="Copy a link to this panel" className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-800/60">
            {copied ? <Check size={14} /> : <Link2 size={14} />}
          </button>
        </div>
      </div>
      <div className="flex-1 mt-4">{children}</div>
      <details className="mt-3 group">
        <summary className="cursor-pointer select-none text-[11px] font-bold text-emerald-600 dark:text-emerald-400 hover:underline list-none">
          <span className="group-open:hidden">How it&apos;s calculated ▸</span>
          <span className="hidden group-open:inline">How it&apos;s calculated ▾</span>
        </summary>
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{how}</div>
      </details>
      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/60 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        <span className="min-w-0">AbaPay · {footer}</span>
        {!compact && <span className="whitespace-nowrap">agents.abapays.com/stats</span>}
      </div>
    </section>
  );
}

function ChartTooltip({ active, payload, label, format, labelFormat }: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string; payload?: { fill?: string } }[];
  label?: string | number;
  format: (v: number) => string;
  labelFormat?: (l: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + n(p.value), 0);
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#18181c] shadow-lg px-3 py-2 text-xs">
      {label !== undefined && <div className="font-black text-slate-900 dark:text-white mb-1">{labelFormat ? labelFormat(String(label)) : label}</div>}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4 text-slate-600 dark:text-slate-300">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />{p.name}</span>
          <span className="font-bold tabular-nums">{format(n(p.value))}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-slate-100 dark:border-slate-800 font-black text-slate-900 dark:text-white">
          <span>Total</span><span className="tabular-nums">{format(total)}</span>
        </div>
      )}
    </div>
  );
}

/* ─── Charts ───────────────────────────────────────────────────────────────── */

const axis = { stroke: 'currentColor', tick: { fill: 'currentColor', fontSize: 11 }, tickLine: false, axisLine: false } as const;

function StackedDaily({ rows, series, format, axisFormat }: {
  rows: Record<string, number | string>[]; series: { key: string; name: string; color: string }[]; format: (v: number) => string; axisFormat: (v: number) => string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (e: LegendPayload) => {
    const key = String(e.dataKey);
    setHidden((h) => { const s = new Set(h); if (s.has(key)) s.delete(key); else s.add(key); return s; });
  };
  return (
    <div className="h-64 text-slate-400 dark:text-slate-500">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
          <XAxis dataKey="day" {...axis} tickFormatter={day} minTickGap={24} />
          <YAxis {...axis} tickFormatter={axisFormat} width={44} />
          <Tooltip cursor={{ fill: 'currentColor', fillOpacity: 0.08 }} content={<ChartTooltip format={format} labelFormat={dayLong} />} />
          <Legend onClick={toggle} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} hide={hidden.has(s.key)} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Donut({ data, format }: { data: { name: string; value: number; detail?: string; color?: string }[]; format: (v: number) => string }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={1} stroke="none">
              {data.map((d, i) => <Cell key={d.name} fill={d.color ?? PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip format={(v) => `${format(v)} · ${total ? ((100 * v) / total).toFixed(1) : 0}%`} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5 text-xs">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-start gap-2 text-slate-600 dark:text-slate-300">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1" style={{ background: d.color ?? PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0">
              <span className="block font-bold text-slate-900 dark:text-white">{d.name}</span>
              <span className="block tabular-nums">{total ? ((100 * d.value) / total).toFixed(1) : 0}% · {format(d.value)}{d.detail ? ` · ${d.detail}` : ''}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── The dashboard ────────────────────────────────────────────────────────── */

export default function Dashboard({ d }: { d: DashboardData }) {
  const [range, setRange] = useState<RangeKey>('90');
  const footer = `${d.chainName} · as of ${d.asOf}`;
  const footerShort = `${d.chainName} · ${d.asOf.split(',').slice(0, 2).join(',')}`;

  // Every calendar day from the first payment to today, so days with no payments show as gaps.
  const allDays = useMemo(() => {
    const byDay = new Map(d.daily.map((r) => [r.day.slice(0, 10), r]));
    const first = d.daily[0]?.day.slice(0, 10);
    if (!first) return [];
    const out: DashboardData['daily'] = [];
    const end = new Date(); end.setUTCHours(0, 0, 0, 0);
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= end.getTime(); t += 86_400_000) {
      const k = new Date(t).toISOString().slice(0, 10);
      out.push(byDay.get(k) ?? { day: k, direct: 0, agent: 0, x402: 0, wallets: 0, new_wallets: 0, volume_usd: 0, volume_direct: 0, volume_agent: 0, volume_x402: 0 });
    }
    return out;
  }, [d.daily]);

  const cumulative = useMemo(() => {
    let run = 0;
    return allDays.map((r) => ({ day: r.day.slice(0, 10), total: (run += n(r.volume_usd)) }));
  }, [allDays]);

  const days = RANGES.find((r) => r.key === range)!.days;
  const shown = Number.isFinite(days) ? allDays.slice(-days) : allDays;
  const shownCum = Number.isFinite(days) ? cumulative.slice(-days) : cumulative;
  const hasRailVolume = d.daily.some((r) => r.volume_x402 !== undefined);

  const paymentsRows = shown.map((r) => ({ day: r.day.slice(0, 10), x402: n(r.x402), agent: n(r.agent), direct: n(r.direct) }));
  const volumeRows = shown.map((r) => ({ day: r.day.slice(0, 10), x402: n(r.volume_x402), agent: n(r.volume_agent), direct: n(r.volume_direct) }));
  const walletRows = shown.map((r) => ({ day: r.day.slice(0, 10), new_wallets: n(r.new_wallets), returning: Math.max(n(r.wallets) - n(r.new_wallets), 0) }));

  const volume = n(d.totals.volume_usd);
  const agentPct = volume > 0 ? (100 * n(d.totals.agent_volume_usd)) / volume : 0;
  const hackathon = d.hackathonTag ? d.tags.find((t) => t.tag === d.hackathonTag) : undefined;
  const since = d.totals.first_payment ? dayLong(d.totals.first_payment) : '';

  const rangeToggle = (
    <div className="inline-flex rounded-full border border-slate-200 dark:border-slate-800 p-0.5" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button key={r.key} type="button" onClick={() => setRange(r.key)} aria-pressed={range === r.key}
          className={`px-3 py-1 rounded-full text-[11px] font-black ${range === r.key ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-500 hover:text-emerald-600'}`}>
          {r.label}
        </button>
      ))}
    </div>
  );

  const COUNTERS: { id: string; title: string; value: string; description: string; how: ReactNode }[] = [
    { id: 'payments', title: 'Payments', value: nf.format(n(d.totals.payments)), description: `All payments into AbaPay's vaults on ${d.chainName} since ${since}.`, how: <>One row per payment: a <code>PaymentReceived</code> event for a contract payment, or a stablecoin transfer into a vault for x402. Includes payments that were later refunded; this is what the chain recorded.</> },
    { id: 'wallets', title: 'Unique wallets', value: nf.format(n(d.totals.wallets)), description: 'Distinct addresses that have paid into a vault.', how: <>The payer of each payment: the user for a contract payment, and the address that signed the transfer for x402. Counted once however many times it paid.</> },
    { id: 'volume', title: 'Volume', value: usd0.format(volume), description: 'Total stablecoin value paid in, in US dollars.', how: <>Sum of every payment&apos;s amount. Every accepted token is a US-dollar stablecoin, so amounts are counted at $1, not priced.</> },
    { id: 'agent-share', title: 'Agent-native volume', value: `${agentPct.toFixed(1)}%`, description: 'Share of volume that came through agent rails.', how: <>x402 plus agent-relayer volume, divided by all volume. Direct wallet payments made by a person in the app are the rest.</> },
    { id: 'payments-30d', title: 'Payments, last 30 days', value: nf.format(n(d.last30.payments)), description: 'Payments in the 30 days up to now.', how: <>Same count as Payments, limited to the last 30 days (rolling, not calendar).</> },
    { id: 'wallets-30d', title: 'Wallets, last 30 days', value: nf.format(n(d.last30.wallets)), description: 'Distinct paying wallets in the last 30 days.', how: <>Same as Unique wallets, limited to the last 30 days.</> },
    { id: 'volume-30d', title: 'Volume, last 30 days', value: usd0.format(n(d.last30.volume_usd)), description: 'Stablecoin value paid in over the last 30 days.', how: <>Same as Volume, limited to the last 30 days.</> },
    d.hackathonTag
      ? { id: 'hackathon', title: 'Hackathon-tagged payments', value: nf.format(hackathon ? n(hackathon.payments) : 0), description: `Payments carrying the Celo Open Rails tag ${d.hackathonTag}.`, how: <>Read from the ERC-8021 attribution suffix on each contract payment&apos;s calldata. x402 payments can&apos;t carry it: the x402 facilitator submits those transactions, not AbaPay.</> }
      : { id: 'rails', title: 'Rails in use', value: nf.format(d.byRail.length), description: 'Settlement rails that carried at least one payment.', how: <>Direct wallet, agent relayer and x402.</> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-xs text-slate-400 dark:text-slate-500">
          {d.indexedBlock !== null && <>Indexed to block {nf.format(d.indexedBlock)} · </>}as of {d.asOf} · updated every 15 minutes
        </p>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Charts</span>
          {rangeToggle}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {COUNTERS.map((c) => (
          <Panel key={c.id} id={c.id} title={c.title} description={c.description} how={c.how} footer={footerShort} compact>
            <div className="text-3xl font-black tracking-tight text-slate-900 dark:text-white tabular-nums">{c.value}</div>
          </Panel>
        ))}
      </div>

      <div className="grid gap-4 mb-4">
        <Panel id="daily-payments" title="Daily payments by rail" description="How many payments settled each day, split by how they were paid. Hover or tap a bar for the day's numbers; click a legend item to hide it." footer={footer}
          how={<>Grouped by the UTC day of the block. <b>x402</b>: a stablecoin transfer into a vault with no <code>PaymentReceived</code> in the same transaction. <b>Agent (relayer)</b>: a contract payment whose transaction also emitted <code>AgentPayment</code>. <b>Direct (wallet)</b>: every other contract payment.</>}>
          <StackedDaily rows={paymentsRows} series={RAILS} format={(v) => nf.format(v)} axisFormat={(v) => compact.format(v)} />
        </Panel>

        {hasRailVolume && (
          <Panel id="daily-volume" title="Daily volume by rail" description="US-dollar value paid in each day, split by rail." footer={footer}
            how={<>Sum of payment amounts per UTC day, same rail definitions as Daily payments by rail.</>}>
            <StackedDaily rows={volumeRows} series={RAILS} format={usdSmart} axisFormat={usdCompact} />
          </Panel>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <Panel id="cumulative-volume" title="Cumulative volume" description="Running total of all value paid in." footer={footer}
          how={<>Each day&apos;s volume added to every day before it, from the first payment. The range buttons only change the window shown; the total always counts from the start.</>}>
          <div className="h-64 text-slate-400 dark:text-slate-500">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={shownCum} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="cum" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
                <XAxis dataKey="day" {...axis} tickFormatter={day} minTickGap={24} />
                <YAxis {...axis} tickFormatter={usdCompact} width={48} />
                <Tooltip content={<ChartTooltip format={usdSmart} labelFormat={dayLong} />} />
                <Area type="monotone" dataKey="total" name="Cumulative volume" stroke="#10b981" strokeWidth={2} fill="url(#cum)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel id="wallets" title="Paying wallets per day" description="Distinct wallets that paid each day, split into first-time and returning." footer={footer}
          how={<>A wallet is <b>new</b> on the UTC day of its first ever payment on this chain, and <b>returning</b> on every later day it pays.</>}>
          <StackedDaily rows={walletRows} series={[{ key: 'returning', name: 'Returning', color: '#0ea5e9' }, { key: 'new_wallets', name: 'New', color: '#10b981' }]} format={(v) => nf.format(v)} axisFormat={(v) => compact.format(v)} />
        </Panel>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <Panel id="rail-share" title="Volume by rail" description="Where the money came through, all time." footer={footer}
          how={<>Total volume per rail, as a share of all volume. Same rail definitions as Daily payments by rail.</>}>
          <Donut data={d.byRail.map((r) => ({ name: RAIL_NAME[r.rail], color: RAILS.find((x) => x.key === r.rail)?.color, value: n(r.volume_usd), detail: `${nf.format(n(r.payments))} payments` }))} format={usdSmart} />
        </Panel>
        <Panel id="token-share" title="Volume by token" description="Which stablecoins were used to pay, all time." footer={footer}
          how={<>Total volume per token. USDm is a legacy 18-decimal token, still counted for older contract payments.</>}>
          <Donut data={d.byToken.map((t) => ({ name: t.token_symbol, value: n(t.volume_usd), detail: `${nf.format(n(t.payments))} payments` }))} format={usdSmart} />
        </Panel>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        {d.byService.length > 0 && (
          <Panel id="services" title="What contract payments bought" description="Bill categories paid through the vault contracts, by number of payments." footer={footer}
            how={<>The <code>serviceType</code> field of each <code>PaymentReceived</code> event. x402 payments carry no service on-chain (it lives in the off-chain payment request), so they are not in this chart.</>}>
            <Donut data={d.byService.map((s) => ({ name: s.service_type, value: n(s.payments) }))} format={(v) => `${nf.format(v)} payments`} />
          </Panel>
        )}
        <Panel id="tags" title="Attribution tags" description="ERC-8021 builder tags found on contract payments." footer={footer}
          how={<>Decoded from the data suffix at the end of each contract payment&apos;s calldata. A transaction can carry several tags; each is counted.</>}>
          {d.tags.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No tagged payments yet.</p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500"><th className="pb-2 pr-4">Tag</th><th className="pb-2 pr-4 text-right">Payments</th><th className="pb-2 text-right">Last seen</th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-slate-600 dark:text-slate-300">
                {d.tags.map((t) => (
                  <tr key={t.tag}><td className="py-2 pr-4 font-mono text-xs">{t.tag}</td><td className="py-2 pr-4 text-right tabular-nums">{nf.format(n(t.payments))}</td><td className="py-2 text-right whitespace-nowrap">{when(t.last_payment)}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Panel>
      </div>

      <Panel id="latest" title="Latest payments" description="The most recent payments, each linked to its transaction on the explorer." footer={footer} className="mb-6"
        action={<a href={d.csvHref} className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:underline"><Download size={14} /> CSV</a>}
        how={<>Newest first. The CSV has every indexed payment on this chain with its transaction hash, block, payer, token, amount, rail and tags.</>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500"><th className="pb-2 pr-4">Time</th><th className="pb-2 pr-4">Rail</th><th className="pb-2 pr-4 text-right">Amount</th><th className="pb-2 pr-4">Payer</th><th className="pb-2">Transaction</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-slate-600 dark:text-slate-300">
              {d.latest.map((p) => (
                <tr key={`${p.tx_hash}-${p.log_index}`}>
                  <td className="py-2 pr-4 whitespace-nowrap">{when(p.block_time)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{RAIL_NAME[p.rail]}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-right tabular-nums">{usd2.format(n(p.amount_usd))} {p.token_symbol}</td>
                  <td className="py-2 pr-4 font-mono text-xs"><a href={`${d.explorer}/address/${p.payer}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">{short(p.payer)}</a></td>
                  <td className="py-2 font-mono text-xs"><a href={`${d.explorer}/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline">{short(p.tx_hash)} <ExternalLink size={11} /></a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
