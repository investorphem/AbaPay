"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Fingerprint, Landmark, Loader2, Save, Upload, Undo2, ExternalLink } from "lucide-react";
import { buildAgentPolicyMessage, type AgentPolicyForm } from "@/lib/adminActionMessages";

// ⚡ ADMIN — OUTSIDE AGENTS (x402, MCP, A2A)
//
// What agents that pay AbaPay get, decided by whether their request carries a Self Agent ID the
// registry confirms (src/lib/agentPolicy.ts). Separate from AbaPay's own chat agent above and from
// web/MiniPay customers: nothing here changes what they pay. Every save takes a fresh wallet
// signature. Below: verified agents' bank transfers waiting to be sent (src/lib/bankPayouts.ts).

interface Props {
  adminHeaders: Record<string, string>;
  onSignAdminAction: (message: string) => Promise<string | null>;
}

type Payout = {
  id: string; tx_hash: string; wallet: string; self_agent_id: string; bank_code: string; bank_name: string | null;
  account_number: string; account_name: string | null; amount_ngn: number; status: "AWAITING" | "PAID" | "REFUNDED";
  payout_reference: string | null; proof_mime: string | null; operator_note: string | null; paid_at: string | null; created_at: string;
};

const EMPTY: AgentPolicyForm = {
  agent_ext_max_ngn_per_tx: null, agent_ext_daily_cap_ngn: null,
  verified_agent_discounts_enabled: false, verified_agent_fee_waiver_enabled: false,
  verified_agent_higher_limits_enabled: false, verified_agent_max_ngn_per_tx: null, verified_agent_daily_cap_ngn: null,
  verified_agent_bank_enabled: false,
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !(Number(v) > 0) ? null : Number(v));
const naira = (n: number) => `₦${Number(n).toLocaleString()}`;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function AdminOutsideAgentsPanel({ adminHeaders, onSignAdminAction }: Props) {
  const [form, setForm] = useState<AgentPolicyForm>(EMPTY);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [paying, setPaying] = useState<Record<string, { reference: string; note: string; file: File | null }>>({});

  const apply = useCallback((d: { success?: boolean; message?: string; settings?: Record<string, unknown>; payouts?: Payout[] }) => {
      if (!d.success) { setMsg(d.message || "Could not load."); return; }
      const s = d.settings || {};
      setForm({
        agent_ext_max_ngn_per_tx: num(s.agent_ext_max_ngn_per_tx), agent_ext_daily_cap_ngn: num(s.agent_ext_daily_cap_ngn),
        verified_agent_discounts_enabled: s.verified_agent_discounts_enabled === true,
        verified_agent_fee_waiver_enabled: s.verified_agent_fee_waiver_enabled === true,
        verified_agent_higher_limits_enabled: s.verified_agent_higher_limits_enabled === true,
        verified_agent_max_ngn_per_tx: num(s.verified_agent_max_ngn_per_tx), verified_agent_daily_cap_ngn: num(s.verified_agent_daily_cap_ngn),
        verified_agent_bank_enabled: s.verified_agent_bank_enabled === true,
      });
      setPayouts(d.payouts || []);
      setLoaded(true);
  }, []);

  const fetchData = useCallback(
    () => fetch("/api/admin/outside-agents", { headers: adminHeaders }).then((r) => r.json()).catch(() => ({ success: false, message: "Could not load." })),
    [adminHeaders],
  );
  const load = useCallback(() => fetchData().then(apply), [fetchData, apply]);

  useEffect(() => { fetchData().then(apply); }, [fetchData, apply]);

  const savePolicy = async () => {
    setBusy(true); setMsg("");
    try {
      const timestamp = Date.now();
      const sig = await onSignAdminAction(buildAgentPolicyMessage({ ...form, timestamp }));
      if (!sig) return;
      const res = await fetch("/api/admin/outside-agents", {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ policy: form, confirmSignature: sig, confirmTimestamp: timestamp }),
      });
      const d = await res.json();
      setMsg(d.success ? "Saved. Live within 30 seconds." : d.message || "Not saved.");
      if (d.success) load();
    } finally { setBusy(false); }
  };

  const markPaid = async (p: Payout) => {
    const entry = paying[p.id];
    if (!entry?.reference.trim()) { setMsg("Enter the transfer reference first."); return; }
    setBusy(true); setMsg("");
    try {
      const proof = entry.file ? await readFile(entry.file) : undefined;
      const res = await fetch("/api/admin/outside-agents", {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ payout: { id: p.id, action: "paid", reference: entry.reference, note: entry.note || undefined, proof } }),
      });
      const d = await res.json();
      setMsg(d.success ? `Recorded: ${naira(p.amount_ngn)} to ${p.account_name || p.account_number}. The agent can now read the reference and receipt.` : d.message || "Not saved.");
      if (d.success) load();
    } finally { setBusy(false); }
  };

  const refund = async (p: Payout) => {
    const reason = window.prompt(`Refund instead of sending ${naira(p.amount_ngn)} to ${p.account_name || p.account_number}? Give a reason (the agent sees it):`);
    if (!reason) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/admin/outside-agents", {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ payout: { id: p.id, action: "refund", reason } }),
      });
      const d = await res.json();
      setMsg(d.success ? "Queued for refund (Ops → Refunds)." : d.message || "Not saved.");
      if (d.success) load();
    } finally { setBusy(false); }
  };

  const viewProof = async (p: Payout) => {
    const res = await fetch(`/api/admin/outside-agents?proof=${p.id}`, { headers: adminHeaders });
    if (!res.ok) { setMsg("No receipt on file."); return; }
    window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
  };

  if (!loaded) return <div className="text-xs text-slate-500">{msg || "Loading outside-agent settings…"}</div>;

  const toggle = (k: keyof AgentPolicyForm, label: string, note: string) => (
    <label key={k} className="flex items-start gap-3 py-2 cursor-pointer">
      <input type="checkbox" className="mt-1 accent-emerald-600" checked={form[k] === true} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
      <span><span className="text-sm font-bold text-slate-100">{label}</span><span className="block text-[10px] text-slate-500 leading-relaxed">{note}</span></span>
    </label>
  );
  const cap = (k: keyof AgentPolicyForm, label: string) => (
    <div key={k}>
      <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{label}</label>
      <input type="number" min={1} placeholder="No limit" value={(form[k] as number | null) ?? ""}
        onChange={(e) => setForm({ ...form, [k]: num(e.target.value) })}
        className="w-full mt-1 bg-[#1a1a1f] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-black text-slate-100 outline-none focus:border-emerald-700" />
    </div>
  );

  const awaiting = payouts.filter((p) => p.status === "AWAITING");
  const done = payouts.filter((p) => p.status !== "AWAITING");

  return (
    <div className="space-y-4">
      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5 space-y-4">
        <div>
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 flex items-center gap-2"><Fingerprint size={14} /> Outside agents (x402, MCP, A2A)</h3>
          <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
            Agents that pay AbaPay directly. A <strong>verified</strong> agent signs its request with a Self Agent ID the registry confirms (human-backed, fresh proof).
            Nothing here changes what web or MiniPay customers pay, or AbaPay&apos;s own chat agent above.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {cap("agent_ext_max_ngn_per_tx", "All outside agents: max per order (₦)")}
          {cap("agent_ext_daily_cap_ngn", "All outside agents: max per wallet, 24h (₦)")}
        </div>
        <p className="text-[10px] text-slate-500 -mt-2">On x402. MCP and A2A payments go through the relayer and keep the chat-agent caps above. VTpass&apos;s own provider limits always apply.</p>

        <div className="border-t border-slate-800/60 pt-3">
          <p className="text-[10px] uppercase tracking-widest text-emerald-400 font-black">Verified agents get</p>
          {toggle("verified_agent_discounts_enabled", "Discount campaigns", "Live campaigns apply to verified agents, with the same caps as the web app. Unverified agents get none.")}
          {toggle("verified_agent_fee_waiver_enabled", "No x402 facilitator fee", "Verified agents pay the bill without the $0.001 facilitator fee. AbaPay pays it.")}
          {toggle("verified_agent_higher_limits_enabled", "Higher limits", "Verified agents use the limits below instead (empty = no limit). On MCP/A2A they replace the chat-agent caps.")}
          {form.verified_agent_higher_limits_enabled && (
            <div className="grid sm:grid-cols-2 gap-3 pl-7 pb-2">
              {cap("verified_agent_max_ngn_per_tx", "Verified: max per order (₦)")}
              {cap("verified_agent_daily_cap_ngn", "Verified: max per wallet, 24h (₦)")}
            </div>
          )}
          {toggle("verified_agent_bank_enabled", "Bank transfers (no limit)", "Verified agents can pay bank transfers of any amount. Each one waits below for you to send and record.")}
        </div>

        <button type="button" onClick={savePolicy} disabled={busy} className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold disabled:opacity-50 inline-flex items-center gap-2">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Sign &amp; save
        </button>
      </div>

      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5 space-y-3">
        <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 flex items-center gap-2"><Landmark size={14} /> Bank payouts to send ({awaiting.length})</h3>
        {awaiting.length === 0 && <p className="text-xs text-slate-500">Nothing waiting.</p>}
        {awaiting.map((p) => {
          const e = paying[p.id] || { reference: "", note: "", file: null };
          const set = (patch: Partial<typeof e>) => setPaying({ ...paying, [p.id]: { ...e, ...patch } });
          return (
            <div key={p.id} className="border border-amber-700/40 bg-amber-950/10 rounded-xl p-4 space-y-2">
              <div className="flex flex-wrap justify-between gap-2">
                <p className="text-lg font-black text-white">{naira(p.amount_ngn)}</p>
                <p className="text-[10px] text-slate-500">{new Date(p.created_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })} WAT · Self #{p.self_agent_id}</p>
              </div>
              <p className="text-sm text-slate-200"><strong>{p.account_name || "Name not verified"}</strong> · {p.bank_name || `bank ${p.bank_code}`} · <span className="font-mono">{p.account_number}</span></p>
              <a href={`https://celoscan.io/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-400 inline-flex items-center gap-1 font-mono">{p.tx_hash.slice(0, 14)}… <ExternalLink size={10} /></a>
              <div className="grid sm:grid-cols-3 gap-2">
                <input placeholder="Transfer reference" value={e.reference} onChange={(ev) => set({ reference: ev.target.value })} className="bg-[#1a1a1f] border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" />
                <input placeholder="Note (optional)" value={e.note} onChange={(ev) => set({ note: ev.target.value })} className="bg-[#1a1a1f] border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" />
                <label className="bg-[#1a1a1f] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 inline-flex items-center gap-2 cursor-pointer truncate">
                  <Upload size={12} /> {e.file ? e.file.name : "Receipt (PNG/JPG/PDF, 2 MB)"}
                  <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(ev) => set({ file: ev.target.files?.[0] || null })} />
                </label>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => markPaid(p)} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-50">Mark sent</button>
                <button type="button" disabled={busy} onClick={() => refund(p)} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold disabled:opacity-50 inline-flex items-center gap-1"><Undo2 size={12} /> Refund instead</button>
              </div>
            </div>
          );
        })}
        {done.length > 0 && (
          <details className="text-xs text-slate-400">
            <summary className="cursor-pointer">Recent ({done.length})</summary>
            <div className="divide-y divide-slate-800 mt-2">
              {done.map((p) => (
                <div key={p.id} className="py-2 flex flex-wrap justify-between gap-2">
                  <span>{naira(p.amount_ngn)} · {p.account_name || p.account_number} · <span className={p.status === "PAID" ? "text-emerald-400" : "text-amber-400"}>{p.status}</span>{p.payout_reference ? ` · ref ${p.payout_reference}` : ""}</span>
                  {p.proof_mime && <button type="button" onClick={() => viewProof(p)} className="text-emerald-400 underline">Receipt</button>}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
    </div>
  );
}
