"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Percent, Loader2, Save, Trash2, Plus, ShieldAlert } from "lucide-react";

// ⚡ ADMIN — DISCOUNT / PROMO CAMPAIGNS
//
// Create, schedule, and toggle discount campaigns; monitor how much has actually been given
// away. Enforcement is server-side in src/lib/discounts.ts, checked fresh inside /api/pay —
// a change here is live for the very next transaction, no redeploy.

// AIRTIME/INTERNET/ELECTRICITY/CABLE/BANK/EDUCATION are the web app's canonical categories
// (src/constants/index.ts SERVICES + BANK/EDUCATION tabs). DATA is chat-only — the agent path
// (src/app/api/deai/core/route.ts) tracks mobile data bundles separately from AIRTIME, with no
// equivalent tile in the web app (whose "INTERNET" tile is ISP plans, a different service).
const SERVICE_OPTIONS = ["AIRTIME", "DATA", "INTERNET", "ELECTRICITY", "CABLE", "BANK", "EDUCATION"];

interface Props { adminHeaders: Record<string, string>; }

export function AdminDiscountsPanel({ adminHeaders }: Props) {
  const [campaigns, setCampaigns] = useState<any[] | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: '', type: 'PERCENT', value: '', max_discount_ngn: '',
    max_discount_per_wallet_ngn: '', max_discount_per_destination_ngn: '', max_total_discount_ngn: '',
    services: [] as string[], starts_at: '', ends_at: '',
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/discounts', { headers: adminHeaders });
      const data = await res.json();
      if (data.success) { setCampaigns(data.campaigns); setStats(data.stats); }
    } catch { /* non-fatal */ }
  }, [adminHeaders]);

  useEffect(() => { load(); }, [load]);

  const post = async (body: Record<string, any>) => {
    setSaving(true); setMsg('');
    try {
      const res = await fetch('/api/admin/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) { setMsg('Saved — live immediately.'); await load(); return true; }
      setMsg(data.message || 'Could not save.');
      return false;
    } catch {
      setMsg('Could not save.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const createCampaign = async () => {
    if (!form.name.trim() || !form.value) { setMsg('Name and value are required.'); return; }
    const ok = await post({
      name: form.name.trim(),
      type: form.type,
      value: Number(form.value),
      max_discount_ngn: form.max_discount_ngn ? Number(form.max_discount_ngn) : null,
      max_discount_per_wallet_ngn: form.max_discount_per_wallet_ngn ? Number(form.max_discount_per_wallet_ngn) : null,
      max_discount_per_destination_ngn: form.max_discount_per_destination_ngn ? Number(form.max_discount_per_destination_ngn) : null,
      max_total_discount_ngn: form.max_total_discount_ngn ? Number(form.max_total_discount_ngn) : null,
      services: form.services,
      starts_at: form.starts_at || null,
      ends_at: form.ends_at || null,
      is_active: true,
    });
    if (ok) {
      setForm({ name: '', type: 'PERCENT', value: '', max_discount_ngn: '', max_discount_per_wallet_ngn: '', max_discount_per_destination_ngn: '', max_total_discount_ngn: '', services: [], starts_at: '', ends_at: '' });
      setShowForm(false);
    }
  };

  const toggleActive = (c: any) => post({ id: c.id, is_active: !c.is_active });

  const remove = async (id: string) => {
    if (!confirm('Delete this campaign? This does not undo discounts already given.')) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/discounts?id=${id}`, { method: 'DELETE', headers: adminHeaders });
      const data = await res.json();
      if (data.success) await load();
      else setMsg(data.message || 'Could not delete.');
    } finally {
      setSaving(false);
    }
  };

  const toggleService = (s: string) => {
    setForm((f) => ({ ...f, services: f.services.includes(s) ? f.services.filter((x) => x !== s) : [...f.services, s] }));
  };

  if (!campaigns) {
    return (
      <div className="p-6 flex items-center gap-2 text-slate-400">
        <Loader2 size={16} className="animate-spin" /> <span className="text-xs">Loading discount campaigns…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Monitoring */}
      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Percent size={16} className="text-emerald-500" />
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">Discounts given (successful transactions)</h3>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-[#1a1a1f] rounded-xl p-3 border border-slate-800/80">
            <p className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Total discounted</p>
            <p className="text-xl font-black text-emerald-400 mt-1">₦{(stats?.totalDiscountNgn ?? 0).toLocaleString()}</p>
          </div>
          <div className="bg-[#1a1a1f] rounded-xl p-3 border border-slate-800/80">
            <p className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Discounted transactions</p>
            <p className="text-xl font-black text-slate-100 mt-1">{stats?.discountedTxCount ?? 0}</p>
          </div>
        </div>
      </div>

      {/* Suspicious clusters — flag only, never auto-blocked */}
      {stats?.suspiciousClusters && stats.suspiciousClusters.length > 0 && (
        <div className="bg-[#111114] rounded-2xl border border-orange-900/50 p-5">
          <div className="flex items-center gap-2 mb-1">
            <ShieldAlert size={16} className="text-orange-400" />
            <h3 className="text-xs font-black uppercase tracking-widest text-orange-300">Suspicious activity (last 24h)</h3>
          </div>
          <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
            One IP paying from multiple wallets during an active discount — a possible sign of wallet-farming. Nothing here is auto-blocked; review and deactivate the campaign or investigate manually.
          </p>
          {stats.suspiciousClusters.map((cl: any) => (
            <div key={cl.ip} className="flex items-center justify-between py-2 border-b border-slate-800/60 last:border-0">
              <div>
                <p className="text-xs font-mono font-bold text-slate-200">{cl.ip}</p>
                <p className="text-[9px] text-slate-500">{cl.walletCount} wallets · {cl.txCount} discounted transactions</p>
              </div>
              <p className="text-xs font-black text-orange-400">₦{Number(cl.discountNgn).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}

      {/* Campaign list */}
      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">Campaigns</h3>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-400 hover:text-emerald-300"
          >
            <Plus size={12} /> New campaign
          </button>
        </div>

        {showForm && (
          <div className="bg-[#1a1a1f] rounded-xl border border-slate-800/80 p-4 mb-4 space-y-3">
            <input
              placeholder="Campaign name (e.g. New User Welcome)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
            />
            <div className="grid grid-cols-2 gap-3">
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
              >
                <option value="PERCENT">Percent (%)</option>
                <option value="FIXED">Flat amount (₦)</option>
              </select>
              <input
                type="number"
                placeholder={form.type === 'PERCENT' ? 'e.g. 10' : 'e.g. 100'}
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                className="bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
              />
            </div>
            {form.type === 'PERCENT' && (
              <input
                type="number"
                placeholder="Max discount per transaction in ₦ (optional cap)"
                value={form.max_discount_ngn}
                onChange={(e) => setForm((f) => ({ ...f, max_discount_ngn: e.target.value }))}
                className="w-full bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
              />
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Max ₦ per wallet (optional)</label>
                <input
                  type="number"
                  placeholder="Lifetime cap per user"
                  value={form.max_discount_per_wallet_ngn}
                  onChange={(e) => setForm((f) => ({ ...f, max_discount_per_wallet_ngn: e.target.value }))}
                  className="w-full mt-1 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Max ₦ total budget (optional)</label>
                <input
                  type="number"
                  placeholder="Campaign stops itself at this"
                  value={form.max_total_discount_ngn}
                  onChange={(e) => setForm((f) => ({ ...f, max_total_discount_ngn: e.target.value }))}
                  className="w-full mt-1 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Max ₦ per destination account, per 24h (optional)</label>
              <input
                type="number"
                placeholder="Resets daily — same phone/meter can reuse it tomorrow"
                value={form.max_discount_per_destination_ngn}
                onChange={(e) => setForm((f) => ({ ...f, max_discount_per_destination_ngn: e.target.value }))}
                className="w-full mt-1 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
              />
              <p className="text-[9px] text-slate-600 mt-1">Unlike the per-wallet cap, this rolls off after 24h — closes the "just switch wallets" loophole without punishing a returning legitimate user.</p>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-2">Applies to (leave blank for all services)</p>
              <div className="flex flex-wrap gap-2">
                {SERVICE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleService(s)}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border transition-colors ${
                      form.services.includes(s)
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-transparent border-slate-800/80 text-slate-400'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Starts (optional)</label>
                <input
                  type="datetime-local"
                  value={form.starts_at}
                  onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))}
                  className="w-full mt-1 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-xs font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Ends (optional)</label>
                <input
                  type="datetime-local"
                  value={form.ends_at}
                  onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))}
                  className="w-full mt-1 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-xs font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              </div>
            </div>

            <button
              onClick={createCampaign}
              disabled={saving}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-colors active:scale-95"
            >
              {saving ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Create campaign'}
            </button>
          </div>
        )}

        {campaigns.length === 0 && (
          <p className="text-xs text-slate-500 py-4 text-center">No discount campaigns yet.</p>
        )}

        {campaigns.map((c) => {
          const usage = stats?.byCampaign?.[c.id];
          const usedNgn = usage?.discountNgn ?? 0;
          const budgetExhausted = c.max_total_discount_ngn && usedNgn >= Number(c.max_total_discount_ngn);
          return (
          <div key={c.id} className="flex items-start justify-between gap-4 py-4 border-b border-slate-800/60 last:border-0">
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-black ${c.is_active ? 'text-slate-200' : 'text-slate-500'}`}>
                {c.name}
                {budgetExhausted && <span className="ml-2 text-[9px] font-black uppercase text-orange-400">Budget used up</span>}
              </p>
              <p className="text-[10px] text-slate-500 mt-1">
                {c.type === 'PERCENT' ? `${c.value}% off` : `₦${Number(c.value).toLocaleString()} off`}
                {c.max_discount_ngn ? ` (max ₦${Number(c.max_discount_ngn).toLocaleString()}/tx)` : ''}
                {c.max_discount_per_wallet_ngn ? ` · max ₦${Number(c.max_discount_per_wallet_ngn).toLocaleString()}/wallet` : ''}
                {c.max_discount_per_destination_ngn ? ` · max ₦${Number(c.max_discount_per_destination_ngn).toLocaleString()}/number per 24h` : ''}
                {' · '}
                {c.services && c.services.length > 0 ? c.services.join(', ') : 'All services'}
              </p>
              <p className="text-[10px] text-emerald-500 mt-1 font-bold">
                ₦{usedNgn.toLocaleString()}{c.max_total_discount_ngn ? ` / ₦${Number(c.max_total_discount_ngn).toLocaleString()}` : ''} given
                {usage?.count ? ` · ${usage.count} transaction${usage.count === 1 ? '' : 's'}` : ''}
              </p>
              {(c.starts_at || c.ends_at) && (
                <p className="text-[9px] text-slate-600 mt-1">
                  {c.starts_at ? new Date(c.starts_at).toLocaleString() : 'No start'} → {c.ends_at ? new Date(c.ends_at).toLocaleString() : 'No end'}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => toggleActive(c)}
                disabled={saving}
                className={`relative w-12 h-6 rounded-full transition-colors ${c.is_active ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-50`}
              >
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${c.is_active ? 'left-7' : 'left-1'}`} />
              </button>
              <button onClick={() => remove(c.id)} disabled={saving} className="p-1.5 text-slate-500 hover:text-red-400">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          );
        })}
      </div>

      {msg && (
        <p className="text-[10px] text-emerald-400 flex items-center gap-1.5">
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} {msg}
        </p>
      )}
    </div>
  );
}
