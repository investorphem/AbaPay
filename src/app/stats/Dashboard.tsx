'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toPng } from 'html-to-image';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type LegendPayload,
} from 'recharts';
import { Camera, Check, Download, ExternalLink, Link2, Loader2 } from 'lucide-react';

// The analytics dashboard on stats.abapays.com. Every panel is self-contained (title, description,
// "how it's calculated", chain and date in its footer), so a screenshot of any one panel still
// says what it shows and where it came from. Hover or tap a bar or slice for its exact values;
// click a legend entry to hide that series.

type Num = number | string;
type Rail = 'direct' | 'agent' | 'x402';
type Window = {
  payments: Num; wallets: Num; new_wallets: Num; volume_usd: Num; agent_volume_usd: Num;
  by_rail: { rail: Rail; payments: Num; wallets: Num; volume_usd: Num }[];
  by_token: { token_symbol: string; payments: Num; volume_usd: Num }[];
  by_chain: { chain: string; payments: Num; volume_usd: Num }[];
  tags: { tag: string; payments: Num; last_payment: string }[];
};

export type DashboardData = {
  chainName: string;
  /** The overview page: both chains, so it adds a by-chain panel and a chain column. */
  overview: boolean;
  explorers: Record<string, string>;
  asOf: string;
  indexedBlocks: { chain: string; block: number }[];
  firstPayment: string | null;
  /** The counters, splits and tags for each range. Only `all` is guaranteed (see StatsView's allTimeOnly). */
  windows: Partial<Record<RangeKey, Window>>;
  /** Distinct paying wallets per Lagos day, and over the 7 and 30 days ending it. Empty without migration 041. */
  active: { day: string; dau: Num; wau: Num; mau: Num }[];
  daily: {
    day: string;
    direct: Num; agent: Num; x402: Num;
    wallets: Num; new_wallets: Num; volume_usd: Num;
    volume_direct?: Num; volume_agent?: Num; volume_x402?: Num;
  }[];
  latest: { chain: string; tx_hash: string; log_index: number; block_time: string; payer: string; token_symbol: string; amount_usd: Num; rail: Rail }[];
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
// Every time on the site is Nigerian time (WAT, UTC+1), and days are Lagos days (migration 040).
// day() and dayLong() format a bare YYYY-MM-DD from the database, which is already a Lagos day, so
// they read it at UTC midnight purely to avoid shifting it.
const TZ = 'Africa/Lagos';
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ }) + ' WAT';
const lagosToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const RAILS: { key: Rail; name: string; color: string }[] = [
  { key: 'x402', name: 'x402', color: '#10b981' },
  { key: 'agent', name: 'Agent (relayer)', color: '#0ea5e9' },
  { key: 'direct', name: 'Direct (wallet)', color: '#94a3b8' },
];
const RAIL_NAME = Object.fromEntries(RAILS.map((r) => [r.key, r.name])) as Record<Rail, string>;
const PALETTE = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#64748b', '#14b8a6', '#eab308'];

// One switch drives the whole page: counters, charts, splits and tags. `phrase` finishes a sentence
// ("Payments in the last 7 days") and goes in every panel's footer, so a screenshot says its range.
const RANGES = [
  { key: '7', label: '7D', days: 7, phrase: 'the last 7 days' },
  { key: '30', label: '30D', days: 30, phrase: 'the last 30 days' },
  { key: '90', label: '90D', days: 90, phrase: 'the last 90 days' },
  { key: 'all', label: 'All', days: Infinity, phrase: 'all time' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/* ─── Panel chrome ─────────────────────────────────────────────────────────── */

function Panel({ id, title, description, how, footer, compact = false, className = '', action, children }: {
  id: string; title: string; description: string; how: ReactNode; footer: string;
  /** Counter tiles: too narrow for the site address, so the footer carries only brand, chain and date. */
  compact?: boolean;
  className?: string; action?: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const [shooting, setShooting] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      location.hash = id;
    }
  };
  // 📷 Saves this panel as a PNG. The buttons are left out of
  // the image, and so is "How it's calculated" unless it is open, so the picture is just the panel.
  const snapshot = async () => {
    const el = ref.current;
    if (!el) return;
    setShooting(true);
    const options = {
      pixelRatio: 2,
      backgroundColor: getComputedStyle(el).backgroundColor,
      filter: (node: HTMLElement) =>
        !(node.dataset && 'noCapture' in node.dataset) && !(node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open),
    };
    try {
      // Embedding the page fonts can fail on some browsers; the image is still worth having without them.
      const url = await toPng(el, options).catch(() => toPng(el, { ...options, skipFonts: true }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `abapay-${id}-${new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())}.png`;
      a.click();
    } finally {
      setShooting(false);
    }
  };
  const btn = 'p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-800/60';
  return (
    <section ref={ref} id={id} className={`min-w-0 scroll-mt-24 bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-3xl p-5 sm:p-6 flex flex-col ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 dark:text-white">{title}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{description}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0" data-no-capture="">
          {action}
          <button type="button" onClick={snapshot} disabled={shooting} aria-label={`Save "${title}" as an image`} title="Save this panel as an image" className={btn}>
            {shooting ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
          </button>
          <button type="button" onClick={copy} aria-label={`Copy a link to "${title}"`} title="Copy a link to this panel" className={btn}>
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
        {!compact && <span className="whitespace-nowrap">stats.abapays.com</span>}
      </div>
    </section>
  );
}

function ChartTooltip({ active, payload, label, format, labelFormat, showTotal = true }: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string; payload?: { fill?: string } }[];
  label?: string | number;
  format: (v: number) => string;
  labelFormat?: (l: string) => string;
  /** False for overlapping series (DAU/WAU/MAU), where a total would be meaningless. */
  showTotal?: boolean;
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
      {showTotal && payload.length > 1 && (
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

const ACTIVE_SERIES = [
  { key: 'mau', name: 'MAU', color: '#8b5cf6' },
  { key: 'wau', name: 'WAU', color: '#0ea5e9' },
  { key: 'dau', name: 'DAU', color: '#10b981' },
];

function ActiveLines({ rows }: { rows: { day: string; dau: number; wau: number; mau: number }[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (e: LegendPayload) => {
    const key = String(e.dataKey);
    setHidden((h) => { const s = new Set(h); if (s.has(key)) s.delete(key); else s.add(key); return s; });
  };
  return (
    <div className="h-64 text-slate-400 dark:text-slate-500">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
          <XAxis dataKey="day" {...axis} tickFormatter={day} minTickGap={24} />
          <YAxis {...axis} tickFormatter={(v: number) => compact.format(v)} width={44} allowDecimals={false} />
          {/* Not a stack: DAU, WAU and MAU overlap, so adding them up would mean nothing. */}
          <Tooltip content={<ChartTooltip format={(v) => nf.format(v)} labelFormat={dayLong} showTotal={false} />} />
          <Legend onClick={toggle} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} />
          {ACTIVE_SERIES.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} hide={hidden.has(s.key)} />
          ))}
        </LineChart>
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
  const [range, setRange] = useState<RangeKey>('30');
  const router = useRouter();
  // Live while open: re-fetch the page's data every 5 minutes without a reload (the range
  // choice and any open notes are kept). New payments reach the index every 15 minutes.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 5 * 60_000);
    return () => clearInterval(t);
  }, [router]);
  // Every calendar day from the first payment to today, so days with no payments show as gaps.
  const allDays = useMemo(() => {
    const byDay = new Map(d.daily.map((r) => [r.day.slice(0, 10), r]));
    const first = d.daily[0]?.day.slice(0, 10);
    if (!first) return [];
    const out: DashboardData['daily'] = [];
    const end = Date.parse(`${lagosToday()}T00:00:00Z`);
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= end; t += 86_400_000) {
      const k = new Date(t).toISOString().slice(0, 10);
      out.push(byDay.get(k) ?? { day: k, direct: 0, agent: 0, x402: 0, wallets: 0, new_wallets: 0, volume_usd: 0, volume_direct: 0, volume_agent: 0, volume_x402: 0 });
    }
    return out;
  }, [d.daily]);

  const cumulative = useMemo(() => {
    let run = 0;
    return allDays.map((r) => ({ day: r.day.slice(0, 10), total: (run += n(r.volume_usd)) }));
  }, [allDays]);

  const R = RANGES.find((r) => r.key === range)!;
  const days = R.days;
  const shown = Number.isFinite(days) ? allDays.slice(-days) : allDays;
  const shownCum = Number.isFinite(days) ? cumulative.slice(-days) : cumulative;
  const shownActive = Number.isFinite(days) ? d.active.slice(-days) : d.active;
  const hasRailVolume = d.daily.some((r) => r.volume_x402 !== undefined);

  const paymentsRows = shown.map((r) => ({ day: r.day.slice(0, 10), x402: n(r.x402), agent: n(r.agent), direct: n(r.direct) }));
  const volumeRows = shown.map((r) => ({ day: r.day.slice(0, 10), x402: n(r.volume_x402), agent: n(r.volume_agent), direct: n(r.volume_direct) }));
  const walletRows = shown.map((r) => ({ day: r.day.slice(0, 10), new_wallets: n(r.new_wallets), returning: Math.max(n(r.wallets) - n(r.new_wallets), 0) }));
  const activeRows = shownActive.map((r) => ({ day: r.day.slice(0, 10), dau: n(r.dau), wau: n(r.wau), mau: n(r.mau) }));

  // The chosen range's numbers. Without migration 041 only `all` exists, and the panels say so.
  const w = d.windows[range] ?? d.windows.all!;
  const wPhrase = d.windows[range] ? R.phrase : 'all time';
  const footer = `${d.chainName} · ${wPhrase} · as of ${d.asOf}`;
  const footerShort = `${d.chainName} · ${wPhrase} · ${d.asOf.split(',').slice(0, 2).join(',')}`;

  const volume = n(w.volume_usd);
  const agentPct = volume > 0 ? (100 * n(w.agent_volume_usd)) / volume : 0;
  const returning = Math.max(n(w.wallets) - n(w.new_wallets), 0);
  const hackathon = d.hackathonTag ? w.tags.find((t) => t.tag === d.hackathonTag) : undefined;
  const since = d.firstPayment
    ? new Date(d.firstPayment).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ })
    : '';
  const inRange = wPhrase === 'all time' ? `since ${since}` : `in ${wPhrase}`;

  // DAU, WAU, MAU as of today (the last row of the series), and how much of the month's base shows
  // up on an average day: the mean DAU over the last 30 days divided by today's MAU.
  const today = d.active.at(-1);
  const last30Active = d.active.slice(-30);
  const avgDau = last30Active.length ? last30Active.reduce((s, r) => s + n(r.dau), 0) / last30Active.length : 0;
  const stickiness = today && n(today.mau) > 0 ? (100 * avgDau) / n(today.mau) : 0;

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

  const rolling = <> Windows are rolling from now (7D is the last 7 × 24 hours), not calendar weeks or months.</>;
  const COUNTERS: { id: string; title: string; value: string; description: string; how: ReactNode }[] = [
    { id: 'payments', title: 'Payments', value: nf.format(n(w.payments)), description: `Payments into AbaPay's vaults on ${d.chainName} ${inRange}.`, how: <>One row per payment: a <code>PaymentReceived</code> event for a contract payment, or a stablecoin transfer into a vault for x402. Includes payments that were later refunded; this is what the chain recorded.{rolling}</> },
    { id: 'wallets', title: 'Unique wallets', value: nf.format(n(w.wallets)), description: `Distinct addresses that paid into a vault ${inRange}.`, how: <>The payer of each payment: the user for a contract payment, and the address that signed the transfer for x402. Counted once however many times it paid in the range.{rolling}</> },
    { id: 'volume', title: 'Volume', value: usd0.format(volume), description: `Stablecoin value paid in ${inRange}, in US dollars.`, how: <>Sum of every payment&apos;s amount. Every accepted token is a US-dollar stablecoin, so amounts are counted at $1, not priced.{rolling}</> },
    { id: 'agent-share', title: 'Agent-native volume', value: `${agentPct.toFixed(1)}%`, description: `Share of volume ${inRange} that came through agent rails.`, how: <>x402 plus agent-relayer volume, divided by all volume in the range. Direct wallet payments made by a person in the app are the rest.</> },
    { id: 'new-wallets', title: 'New wallets', value: nf.format(n(w.new_wallets)), description: `Wallets whose first ever payment was ${inRange}.`, how: <>A wallet is new in the range if its first payment on {d.overview ? 'either chain' : 'this chain'} falls inside it.{rolling}</> },
    { id: 'returning-wallets', title: 'Returning wallets', value: nf.format(returning), description: `Wallets that paid ${inRange} and had paid before it.`, how: <>Unique wallets in the range minus new wallets.</> },
    { id: 'avg-payment', title: 'Average payment', value: usdSmart(n(w.payments) > 0 ? volume / n(w.payments) : 0), description: `Mean payment size ${inRange}.`, how: <>Volume divided by payments, for the range.</> },
    d.hackathonTag
      ? { id: 'hackathon', title: 'Hackathon-tagged payments', value: nf.format(hackathon ? n(hackathon.payments) : 0), description: `Celo payments ${inRange} carrying the Open Rails hackathon tag ${d.hackathonTag}.`, how: <>Read from the ERC-8021 attribution suffix on each contract payment&apos;s calldata. x402 payments can&apos;t carry it: the x402 facilitator submits those transactions, not AbaPay.</> }
      : { id: 'rails', title: 'Rails in use', value: nf.format(w.by_rail.length), description: `Settlement rails that carried at least one payment ${inRange}.`, how: <>Direct wallet, agent relayer and x402.</> },
  ];

  const ACTIVE: { id: string; title: string; value: string; description: string; how: ReactNode }[] = today ? [
    { id: 'dau', title: 'DAU', value: nf.format(n(today.dau)), description: 'Daily active wallets: distinct wallets that paid today (WAT).', how: <>Distinct payers on today&apos;s Nigerian (WAT) calendar day, midnight to now.</> },
    { id: 'wau', title: 'WAU', value: nf.format(n(today.wau)), description: 'Weekly active wallets: distinct wallets that paid in the last 7 days.', how: <>Distinct payers over the 7 WAT days ending today, today included.</> },
    { id: 'mau', title: 'MAU', value: nf.format(n(today.mau)), description: 'Monthly active wallets: distinct wallets that paid in the last 30 days.', how: <>Distinct payers over the 30 WAT days ending today, today included.</> },
    { id: 'stickiness', title: 'Stickiness (DAU/MAU)', value: `${stickiness.toFixed(1)}%`, description: 'How much of the monthly base pays on an average day.', how: <>The average DAU over the last 30 days ({avgDau.toFixed(1)}) divided by MAU. Higher means people come back more often.</> },
  ] : [];

  return (
    <>
      <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">
        {d.indexedBlocks.map((b) => `${b.chain} block ${nf.format(b.block)}`).join(' · ')}{d.indexedBlocks.length > 0 && ' · '}as of {d.asOf} · <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Live</span> · new payments every 15 minutes
      </p>

      {/* The range switch stays in view while scrolling, since it drives every panel below it. */}
      <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 mb-4 rounded-2xl border border-slate-100 dark:border-slate-800/60 bg-white/90 dark:bg-[#111114]/90 backdrop-blur px-4 py-2">
        <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
          Showing <span className="text-slate-900 dark:text-white">{wPhrase}</span>
          {!d.windows[range] && <span className="font-medium text-slate-400"> (range totals unavailable, counters are all-time)</span>}
        </span>
        {rangeToggle}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {COUNTERS.map((c) => (
          <Panel key={c.id} id={c.id} title={c.title} description={c.description} how={c.how} footer={footerShort} compact>
            <div className="text-3xl font-black tracking-tight text-slate-900 dark:text-white tabular-nums">{c.value}</div>
          </Panel>
        ))}
      </div>

      {ACTIVE.length > 0 && (
        <>
          <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-8 mb-3 px-1">Active wallets</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {ACTIVE.map((c) => (
              <Panel key={c.id} id={c.id} title={c.title} description={c.description} how={c.how} footer={`${d.chainName} · ${d.asOf.split(',').slice(0, 2).join(',')}`} compact>
                <div className="text-3xl font-black tracking-tight text-slate-900 dark:text-white tabular-nums">{c.value}</div>
              </Panel>
            ))}
          </div>
          <div className="grid gap-4 mb-4">
            <Panel id="active-wallets" title="DAU, WAU and MAU over time" description="Distinct paying wallets on each day, and over the 7 and 30 days ending it. Hover or tap for a day's numbers; click a legend item to hide it." footer={footer}
              how={<>For each Nigerian (WAT) day: <b>DAU</b> counts distinct payers that day, <b>WAU</b> over the 7 days ending that day, <b>MAU</b> over the 30 days ending that day. A wallet that pays every day counts once in each.</>}>
              <ActiveLines rows={activeRows} />
            </Panel>
          </div>
        </>
      )}

      <div className="grid gap-4 mb-4">
        <Panel id="daily-payments" title="Daily payments by rail" description="How many payments settled each day, split by how they were paid. Hover or tap a bar for the day's numbers; click a legend item to hide it." footer={footer}
          how={<>Grouped by the Nigerian (WAT) day of the block. <b>x402</b>: a stablecoin transfer into a vault with no <code>PaymentReceived</code> in the same transaction. <b>Agent (relayer)</b>: a contract payment whose transaction also emitted <code>AgentPayment</code>. <b>Direct (wallet)</b>: every other contract payment.</>}>
          <StackedDaily rows={paymentsRows} series={RAILS} format={(v) => nf.format(v)} axisFormat={(v) => compact.format(v)} />
        </Panel>

        {hasRailVolume && (
          <Panel id="daily-volume" title="Daily volume by rail" description="US-dollar value paid in each day, split by rail." footer={footer}
            how={<>Sum of payment amounts per Nigerian (WAT) day, same rail definitions as Daily payments by rail.</>}>
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
          how={<>A wallet is <b>new</b> on the Nigerian (WAT) day of its first ever payment on this chain, and <b>returning</b> on every later day it pays.</>}>
          <StackedDaily rows={walletRows} series={[{ key: 'returning', name: 'Returning', color: '#0ea5e9' }, { key: 'new_wallets', name: 'New', color: '#10b981' }]} format={(v) => nf.format(v)} axisFormat={(v) => compact.format(v)} />
        </Panel>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        {d.overview && w.by_chain.length > 0 && (
          <Panel id="chain-share" title="Volume by chain" description={`How AbaPay's volume splits between Celo and Base, ${inRange}.`} footer={footer}
            how={<>Volume per chain across every indexed vault on it, for the range.</>}>
            <Donut data={w.by_chain.map((c) => ({ name: c.chain === 'CELO' ? 'Celo' : 'Base', value: n(c.volume_usd), detail: `${nf.format(n(c.payments))} payments`, color: c.chain === 'CELO' ? '#facc15' : '#3b82f6' }))} format={usdSmart} />
          </Panel>
        )}
        <Panel id="rail-share" title="Volume by rail" description={`Where the money came through, ${inRange}.`} footer={footer}
          how={<>Volume per rail in the range, as a share of all volume in it. Same rail definitions as Daily payments by rail.</>}>
          <Donut data={w.by_rail.map((r) => ({ name: RAIL_NAME[r.rail], color: RAILS.find((x) => x.key === r.rail)?.color, value: n(r.volume_usd), detail: `${nf.format(n(r.payments))} payments` }))} format={usdSmart} />
        </Panel>
        <Panel id="token-share" title="Volume by token" description={`Which stablecoins were used to pay, ${inRange}.`} footer={footer}
          how={<>Volume per token in the range. USDm is a legacy 18-decimal token, still counted for older contract payments.</>}>
          <Donut data={w.by_token.map((t) => ({ name: t.token_symbol, value: n(t.volume_usd), detail: `${nf.format(n(t.payments))} payments` }))} format={usdSmart} />
        </Panel>
        <Panel id="tags" title="Attribution tags" description={`ERC-8021 builder tags found on contract payments ${inRange}.`} footer={footer}
          how={<>Decoded from the data suffix at the end of each contract payment&apos;s calldata. A transaction can carry several tags; each is counted.</>}>
          {w.tags.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No tagged payments in this range.</p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500"><th className="pb-2 pr-4">Tag</th><th className="pb-2 pr-4 text-right">Payments</th><th className="pb-2 text-right">Last seen</th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-slate-600 dark:text-slate-300">
                {w.tags.map((t) => (
                  <tr key={t.tag}><td className="py-2 pr-4 font-mono text-xs">{t.tag}</td><td className="py-2 pr-4 text-right tabular-nums">{nf.format(n(t.payments))}</td><td className="py-2 text-right whitespace-nowrap">{when(t.last_payment)}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Panel>
      </div>

      <Panel id="latest" title="Latest payments" description="The most recent payments, each linked to its transaction on the explorer." footer={footer} className="mb-6"
        action={<a href={d.csvHref} className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:underline"><Download size={14} /> CSV</a>}
        how={<>Newest first. The CSV has every indexed payment{d.overview ? ' on both chains' : ' on this chain'} with its transaction hash, block, payer, token, amount, rail and tags.</>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500"><th className="pb-2 pr-4">Time</th>{d.overview && <th className="pb-2 pr-4">Chain</th>}<th className="pb-2 pr-4">Rail</th><th className="pb-2 pr-4 text-right">Amount</th><th className="pb-2 pr-4">Payer</th><th className="pb-2">Transaction</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 text-slate-600 dark:text-slate-300">
              {d.latest.map((p) => (
                <tr key={`${p.tx_hash}-${p.log_index}`}>
                  <td className="py-2 pr-4 whitespace-nowrap">{when(p.block_time)}</td>
                  {d.overview && <td className="py-2 pr-4 whitespace-nowrap">{p.chain === 'CELO' ? 'Celo' : 'Base'}</td>}
                  <td className="py-2 pr-4 whitespace-nowrap">{RAIL_NAME[p.rail]}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-right tabular-nums">{usd2.format(n(p.amount_usd))} {p.token_symbol}</td>
                  <td className="py-2 pr-4 font-mono text-xs"><a href={`${d.explorers[p.chain]}/address/${p.payer}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">{short(p.payer)}</a></td>
                  <td className="py-2 font-mono text-xs"><a href={`${d.explorers[p.chain]}/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline">{short(p.tx_hash)} <ExternalLink size={11} /></a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
