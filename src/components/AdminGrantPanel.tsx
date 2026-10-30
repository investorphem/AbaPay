"use client";

import { useState } from "react";
import { Download, Loader2, CheckCircle2, Circle, ExternalLink } from "lucide-react";

// 📊 Prezenti grant, milestone 1 — external-agent payments in a window (src/lib/grantReport.ts).
// Counted from the chain (the on-chain indexer's Celo vault payments), not from AbaPay's own
// records. Pick the 30-day window, see progress against each target, and download the CSV the
// final report attaches. `to` is exclusive.

type Agent = { agent: string; identified: boolean; integrations: string[]; erc8004_id: string | null; self_agent: string | null; payments: number; wallets: number; volume_usd: number; first_tx: string };
type Report = {
  indexed: { block: number | null; at: string | null };
  onchain_total: { payments: number; volume_usd: number };
  totals: { payments: number; wallets: number; volume_usd: number; agents: number };
  breakdown: { recorded: number; onchain_only: number; unidentified_payments: number };
  excluded: { excluded_wallet: number; abapay_web_app_or_own_agent: number; not_delivered: number; relayer_without_order: number };
  targets: { agents: number; payments: number; wallets: number; volumeUsd: number };
  met: { payments: boolean; wallets: boolean; volume: boolean; agents: boolean };
  agents: Agent[];
  excluded_wallets: number;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

export function AdminGrantPanel({ adminHeaders }: { adminHeaders: Record<string, string> }) {
  const today = new Date();
  const [from, setFrom] = useState(day(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(day(new Date(today.getTime() + 86_400_000)));
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const query = `/api/admin/grant-report?from=${from}&to=${to}`;
  const run = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(query, { headers: adminHeaders });
      const d = await res.json();
      if (!d.success) throw new Error(d.message || "Could not build the report.");
      setReport(d.report);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const downloadCsv = async () => {
    const res = await fetch(`${query}&format=csv`, { headers: adminHeaders });
    if (!res.ok) { setError("Could not download the CSV."); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `abapay-external-agent-payments_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const card = (label: string, value: string, target: string, met: boolean) => (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold flex items-center gap-1.5">{met ? <CheckCircle2 size={12} className="text-emerald-500" /> : <Circle size={12} />} {label}</p>
      <p className="text-2xl font-black text-white mt-1 tabular-nums">{value}</p>
      <p className="text-[11px] text-slate-500">target {target}</p>
    </div>
  );

  return (
    <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6 space-y-5">
      <div>
        <h3 className="text-lg font-black text-white">Prezenti grant — external agent payments</h3>
        <p className="text-xs text-slate-500 mt-1">Counted from the chain: every Celo x402 and relayer payment into AbaPay&apos;s vaults, whether or not AbaPay has an order for it. AbaPay&apos;s records only name the agent and apply the exclusions: the web app, AbaPay&apos;s own chat agent, undelivered (refunded/failed) orders and excluded wallets. Only payers we can name count as agents.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">To (exclusive)<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block mt-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" /></label>
        <button type="button" onClick={run} disabled={busy} className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold disabled:opacity-50 inline-flex items-center gap-2">{busy && <Loader2 size={14} className="animate-spin" />} Build report</button>
        {report && <button type="button" onClick={downloadCsv} className="px-5 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-bold inline-flex items-center gap-2"><Download size={14} /> CSV</button>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {card("Agents / apps", String(report.totals.agents), `≥ ${report.targets.agents}`, report.met.agents)}
            {card("Payments", report.totals.payments.toLocaleString(), `≥ ${report.targets.payments.toLocaleString()}`, report.met.payments)}
            {card("Paying wallets", String(report.totals.wallets), `≥ ${report.targets.wallets}`, report.met.wallets)}
            {card("Volume", `$${report.totals.volume_usd.toLocaleString()}`, `≥ $${report.targets.volumeUsd.toLocaleString()}`, report.met.volume)}
          </div>
          <div className="text-[11px] text-slate-500 space-y-1">
            <p>
              On chain in this window: <span className="text-slate-300 font-bold">{report.onchain_total.payments.toLocaleString()} payments · ${report.onchain_total.volume_usd.toLocaleString()}</span>
              {report.indexed.at ? <> · indexed to block {report.indexed.block?.toLocaleString()} at {new Date(report.indexed.at).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })} WAT</> : null}
            </p>
            <p>
              Counted: {report.breakdown.recorded.toLocaleString()} with an AbaPay order · <span className="text-amber-400 font-bold">{report.breakdown.onchain_only.toLocaleString()} on chain with no AbaPay order</span> · {report.breakdown.unidentified_payments.toLocaleString()} from payers we can&apos;t name.
            </p>
            <p>
              Excluded: {report.excluded.abapay_web_app_or_own_agent} AbaPay web app / own agent · {report.excluded.not_delivered} not delivered · {report.excluded.excluded_wallet} from excluded wallets ({report.excluded_wallets} on the list: GRANT_EXCLUDED_WALLETS + admin/relayer/server) · {report.excluded.relayer_without_order} relayer payments with no order.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="text-slate-500 border-b border-slate-800 uppercase text-[10px]"><th className="py-2 pr-3">Agent / app</th><th className="py-2 pr-3">Rail</th><th className="py-2 pr-3">IDs</th><th className="py-2 pr-3">Payments</th><th className="py-2 pr-3">Wallets</th><th className="py-2 pr-3">Volume</th><th className="py-2">First tx</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {report.agents.map((a) => (
                  <tr key={a.agent} className={a.identified ? "text-slate-300" : "text-slate-500"}>
                    <td className={`py-2 pr-3 font-bold ${a.identified ? "text-white" : "text-slate-400 italic"}`}>{a.agent}{!a.identified && <span className="block text-[10px] font-normal not-italic">not counted as an agent</span>}</td>
                    <td className="py-2 pr-3">{a.integrations.join(", ")}</td>
                    <td className="py-2 pr-3">{a.erc8004_id ? `ERC-8004 #${a.erc8004_id}` : "—"}{a.self_agent ? ` · Self ${a.self_agent}` : ""}</td>
                    <td className="py-2 pr-3 tabular-nums">{a.payments}</td>
                    <td className="py-2 pr-3 tabular-nums">{a.wallets}</td>
                    <td className="py-2 pr-3 tabular-nums">${a.volume_usd.toLocaleString()}</td>
                    <td className="py-2"><a href={`https://celoscan.io/tx/${a.first_tx}`} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline inline-flex items-center gap-1 font-mono">{a.first_tx.slice(0, 10)}… <ExternalLink size={10} /></a></td>
                  </tr>
                ))}
                {!report.agents.length && <tr><td colSpan={7} className="py-6 text-center text-slate-500">No external-agent payments on chain in this window yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
