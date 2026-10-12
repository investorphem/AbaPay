// Small server-rendered SVG charts for /agents/stats. No chart library: three chart shapes don't
// justify a client-side dependency, and plain SVG renders before any JavaScript loads. Hovering a
// bar or point shows its exact value (an SVG <title>).

// A narrow drawing area on purpose: the SVG scales to the card's width, and a wide viewBox shrinks
// the axis labels to unreadable on a phone.
const W = 480;
const H = 200;
const PAD = { top: 10, right: 8, bottom: 24, left: 40 };
const IW = W - PAD.left - PAD.right;
const IH = H - PAD.top - PAD.bottom;

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A "nice" axis maximum (1, 2 or 5 times a power of ten) at or above v. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

function Frame({ max, labels, format, children }: { max: number; labels: string[]; format: (v: number) => string; children: React.ReactNode }) {
  const ticks = [0, max / 2, max];
  const xIdx = labels.length > 2 ? [0, Math.floor((labels.length - 1) / 2), labels.length - 1] : labels.map((_, i) => i);
  const step = IW / Math.max(labels.length, 1);
  return (
    <>
      {ticks.map((t) => {
        const y = PAD.top + IH - (t / max) * IH;
        return (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className="stroke-slate-100 dark:stroke-slate-800" strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={12}>{format(t)}</text>
          </g>
        );
      })}
      {children}
      {xIdx.map((i) => (
        <text key={i} x={PAD.left + step * i + step / 2} y={H - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} className="fill-slate-400 dark:fill-slate-500" fontSize={12}>
          {shortDate(labels[i])}
        </text>
      ))}
    </>
  );
}

export type Series = { key: string; name: string; className: string };

/** Stacked bars, one per day. */
export function StackedBars({ days, rows, series, unit }: { days: string[]; rows: Record<string, number>[]; series: Series[]; unit: string }) {
  const totals = rows.map((r) => series.reduce((s, x) => s + (r[x.key] || 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const step = IW / Math.max(days.length, 1);
  const bw = Math.max(step * 0.72, 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${unit} per day`}>
      <Frame max={max} labels={days} format={(v) => compact.format(v)}>
        {rows.map((r, i) => {
          let y = PAD.top + IH;
          return (
            <g key={days[i]}>
              <title>{`${shortDate(days[i])}: ${series.map((s) => `${s.name} ${r[s.key] || 0}`).join(', ')}`}</title>
              {series.map((s) => {
                const h = ((r[s.key] || 0) / max) * IH;
                y -= h;
                return h > 0 ? <rect key={s.key} x={PAD.left + step * i + (step - bw) / 2} y={y} width={bw} height={h} className={s.className} /> : null;
              })}
            </g>
          );
        })}
      </Frame>
    </svg>
  );
}

/** A filled line, for a running total. */
export function AreaLine({ days, values, format, label }: { days: string[]; values: number[]; format: (v: number) => string; label: string }) {
  const max = niceMax(Math.max(0, ...values));
  const step = IW / Math.max(days.length, 1);
  const pts = values.map((v, i) => [PAD.left + step * i + step / 2, PAD.top + IH - (v / max) * IH] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${pts.at(-1)![0].toFixed(1)},${PAD.top + IH} L${pts[0][0].toFixed(1)},${PAD.top + IH} Z` : '';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={label}>
      <Frame max={max} labels={days} format={format}>
        <path d={area} className="fill-emerald-500/15" />
        <path d={line} fill="none" className="stroke-emerald-500" strokeWidth={2} />
        {pts.map(([x, y], i) => (
          <circle key={days[i]} cx={x} cy={y} r={Math.min(step / 2, 4)} className="fill-transparent">
            <title>{`${shortDate(days[i])}: ${format(values[i])}`}</title>
          </circle>
        ))}
      </Frame>
    </svg>
  );
}

/** Fills the days with no payments, so gaps show as gaps instead of being squeezed out. */
export function fillDays<T extends { day: string }>(rows: T[], days: number, empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((r) => [r.day.slice(0, 10), r]));
  const out: T[] = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(d) ?? empty(d));
  }
  return out;
}
