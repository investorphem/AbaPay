"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Percent, Loader2, Save, Trash2, Plus, ShieldAlert } from "lucide-react";
import { buildDiscountCreateMessage } from "@/lib/adminActionMessages";

// ⚡ ADMIN — DISCOUNT / PROMO CAMPAIGNS
//
// Create, schedule, and toggle discount campaigns; monitor how much has actually been given
// away; and turn each anti-gaming measure on or off per campaign, plus a master switch for the
// suspicious-cluster detector. Enforcement is server-side in src/lib/discounts.ts, checked
// fresh inside /api/pay and the chat/agent path — a change here is live for the very next
// transaction, no redeploy.

// AIRTIME/INTERNET/ELECTRICITY/CABLE/BANK/EDUCATION are the web app's canonical categories
// (src/constants/index.ts SERVICES + BANK/EDUCATION tabs). DATA is chat-only — the agent path
// (src/app/api/deai/core/route.ts) tracks mobile data bundles separately from AIRTIME, with no
// equivalent tile in the web app (whose "INTERNET" tile is ISP plans, a different service).
const SERVICE_OPTIONS = ["AIRTIME", "DATA", "INTERNET", "ELECTRICITY", "CABLE", "BANK", "EDUCATION"];

const EMPTY_FORM = {
  name: '', type: 'PERCENT', value: '', max_discount_ngn: '',
  max_discount_per_wallet_ngn: '', max_discount_per_destination_ngn: '', max_discount_per_phone_ngn: '', max_total_discount_ngn: '',
  services: [] as string[], starts_at: '', ends_at: '',
};

const EMPTY_CAPS_ON = { wallet: false, destination: false, phone: false, total: false };

interface Props {
  adminHeaders: Record<string, string>;
  /** Requests a FRESH wallet signature over `message` — used to step-up-confirm creating a
   * campaign, on top of the standard admin session (see admin/page.tsx's signAdminAction). */
  onSignAdminAction: (message: string) => Promise<string | null>;
}

// A tiny toggle switch, matching AdminAgentPanel's pattern — used both for per-cap on/off in
// the create form and the master fraud-flagging switch.
function MiniToggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${value ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-50`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-5' : 'left-0.5'}`} />
    </button>
  );
}

export function AdminDiscountsPanel({ adminHeaders, onSignAdminAction }: Props) {
  const [campaigns, setCampaigns] = useState<any[] | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [exclusions, setExclusions] = useState<any[]>([]);
  const [settings, setSettings] = useState<{ fraudFlaggingEnabled: boolean }>({ fraudFlaggingEnabled: true });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({ ...EMPTY_FORM });
  // Each optional cap starts OFF — the number field only appears (and only gets sent) once its
  // toggle is on, so "turning a gaming protection on/off" is an explicit switch, not just an
  // implicit blank-field convention.
  const [capsOn, setCapsOn] = useState({ ...EMPTY_CAPS_ON });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/discounts', { headers: adminHeaders });
      const data = await res.json();
      if (data.success) { setCampaigns(data.campaigns); setStats(data.stats); setExclusions(data.exclusions || []); if (data.settings) setSettings(data.settings); }
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

  const toggleFraudFlagging = (v: boolean) => post({ fraud_flagging_enabled: v });

  const createCampaign = async () => {
    if (!form.name.trim() || !form.value) { setMsg('Name and value are required.'); return; }

    // 🔒 STEP-UP CONFIRMATION — a fresh wallet signature over these exact parameters, required
    // in addition to the standard admin session (see src/app/api/admin/discounts/route.ts's
    // create branch and src/lib/adminActionMessages.ts for why: a hijacked/replayed session
    // proves nothing about live wallet control). Signing happens BEFORE the network request —
    // if the admin rejects or the wallet errors, nothing is sent to the server at all.
    const name = form.name.trim();
    const value = Number(form.value);
    const timestamp = Date.now();
    setMsg('Confirm the signature request in your wallet…');
    const confirmSignature = await onSignAdminAction(buildDiscountCreateMessage({ name, type: form.type, value, timestamp }));
    if (!confirmSignature) { setMsg('Cancelled — campaign not created.'); return; }

    const ok = await post({
      name,
      type: form.type,
      value,
      max_discount_ngn: form.max_discount_ngn ? Number(form.max_discount_ngn) : null,
      max_discount_per_wallet_ngn: capsOn.wallet && form.max_discount_per_wallet_ngn ? Number(form.max_discount_per_wallet_ngn) : null,
      max_discount_per_destination_ngn: capsOn.destination && form.max_discount_per_destination_ngn ? Number(form.max_discount_per_destination_ngn) : null,
      max_discount_per_phone_ngn: capsOn.phone && form.max_discount_per_phone_ngn ? Number(form.max_discount_per_phone_ngn) : null,
      max_total_discount_ngn: capsOn.total && form.max_total_discount_ngn ? Number(form.max_total_discount_ngn) : null,
      services: form.services,
      starts_at: form.starts_at || null,
      ends_at: form.ends_at || null,
      is_active: true,
      confirmSignature,
      confirmTimestamp: timestamp,
    });
    if (ok) {
      setForm({ ...EMPTY_FORM });
      setCapsOn({ ...EMPTY_CAPS_ON });
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

  // Admin decision off the "Suspicious activity" panel — remove a flagged wallet (and/or the
  // destination accounts it used) from a specific campaign it was seen using.
  const excludeWallet = async (campaignId: string, wallet: string, accounts: string[]) => {
    const label = accounts.length > 0 ? `wallet ${wallet} (and account ${accounts[0]})` : `wallet ${wallet}`;
    if (!confirm(`Remove ${label} from this campaign? It will get the normal, undiscounted price from now on — this doesn't affect discounts already given.`)) return;
    await post({ exclude: { campaign_id: campaignId, wallet_address: wallet } });
  };

  const removeExclusion = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/discounts?id=${id}&type=exclusion`, { method: 'DELETE', headers: adminHeaders });
      const data = await res.json();
      if (data.success) await load();
      else setMsg(data.message || 'Could not remove exclusion.');
    } finally {
      setSaving(false);
    }
  };

  const campaignName = (id: string) => campaigns?.find((c) => c.id === id)?.name || id.slice(0, 8);

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

      {/* Master fraud-flagging switch + suspicious clusters — flag only, never auto-blocked */}
      <div className="bg-[#111114] rounded-2xl border border-orange-900/50 p-5">
        <div className="flex items-center justify-between gap-4 mb-1">
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-orange-400" />
            <h3 className="text-xs font-black uppercase tracking-widest text-orange-300">Suspicious-activity detector</h3>
          </div>
          <MiniToggle value={settings.fraudFlaggingEnabled} onChange={toggleFraudFlagging} disabled={saving} />
        </div>
        <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
          One IP paying from multiple wallets during an active discount — a possible sign of wallet-farming. Nothing here is auto-blocked; review and deactivate the campaign or investigate manually. Turn this off to stop tracking/showing it entirely.
        </p>
        {!settings.fraudFlaggingEnabled && (
          <p className="text-[10px] text-slate-600 italic">Detector is off.</p>
        )}
        {settings.fraudFlaggingEnabled && (!stats?.suspiciousClusters || stats.suspiciousClusters.length === 0) && (
          <p className="text-[10px] text-slate-600 italic">Nothing flagged in the last 24h.</p>
        )}
        {settings.fraudFlaggingEnabled && stats?.suspiciousClusters?.map((cl: any) => (
          <div key={cl.ip} className="py-3 border-b border-slate-800/60 last:border-0">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-mono font-bold text-slate-200">{cl.ip}</p>
              <p className="text-xs font-black text-orange-400">₦{Number(cl.discountNgn).toLocaleString()} · {cl.walletCount} wallets</p>
            </div>
            <div className="space-y-1.5 pl-3 border-l-2 border-orange-900/40">
              {cl.wallets.map((w: any) => (
                <div key={w.wallet} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-mono text-slate-400 truncate">{w.wallet}</p>
                    <p className="text-[9px] text-slate-600">
                      ₦{Number(w.discountNgn).toLocaleString()} · {w.txCount} tx{w.accounts.length > 0 ? ` · acct ${w.accounts[0]}${w.accounts.length > 1 ? ` +${w.accounts.length - 1}` : ''}` : ''}
                    </p>
                  </div>
                  {w.campaignIds.map((cid: string) => (
                    <button
                      key={cid}
                      onClick={() => excludeWallet(cid, w.wallet, w.accounts)}
                      disabled={saving}
                      className="shrink-0 text-[9px] font-black uppercase tracking-widest text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      Exclude from {campaignName(cid)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Currently excluded wallets/accounts */}
      {exclusions.length > 0 && (
        <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5">
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 mb-3">Excluded from campaigns</h3>
          {exclusions.map((ex: any) => (
            <div key={ex.id} className="flex items-center justify-between py-2 border-b border-slate-800/60 last:border-0">
              <div className="min-w-0">
                <p className="text-[10px] font-mono text-slate-300 truncate">{ex.wallet_address || ex.account_number}</p>
                <p className="text-[9px] text-slate-500">{campaignName(ex.campaign_id)}</p>
              </div>
              <button onClick={() => removeExclusion(ex.id)} disabled={saving} className="p-1.5 text-slate-500 hover:text-emerald-400 shrink-0">
                <Trash2 size={13} />
              </button>
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

            <div className="border-t border-slate-800/60 pt-3 mt-1">
              <p className="text-[10px] uppercase tracking-widest text-slate-400 font-black mb-2">Anti-gaming protections — each is off by default</p>

              {/* Per-wallet lifetime cap */}
              <div className="flex items-center justify-between gap-3 py-2">
                <div className="flex-1">
                  <p className="text-[11px] font-bold text-slate-300">Max ₦ per wallet (lifetime)</p>
                  <p className="text-[9px] text-slate-600">Stops one wallet address from repeatedly claiming this promo.</p>
                </div>
                <MiniToggle value={capsOn.wallet} onChange={(v) => setCapsOn((c) => ({ ...c, wallet: v }))} />
              </div>
              {capsOn.wallet && (
                <input
                  type="number"
                  placeholder="e.g. 100000"
                  value={form.max_discount_per_wallet_ngn}
                  onChange={(e) => setForm((f) => ({ ...f, max_discount_per_wallet_ngn: e.target.value }))}
                  className="w-full mb-2 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              )}

              {/* Per-destination 24h cap */}
              <div className="flex items-center justify-between gap-3 py-2">
                <div className="flex-1">
                  <p className="text-[11px] font-bold text-slate-300">Max ₦ per destination number, per 24h</p>
                  <p className="text-[9px] text-slate-600">Resets daily — same phone/meter can reuse it tomorrow. Closes the "just switch wallets" loophole.</p>
                </div>
                <MiniToggle value={capsOn.destination} onChange={(v) => setCapsOn((c) => ({ ...c, destination: v }))} />
              </div>
              {capsOn.destination && (
                <input
                  type="number"
                  placeholder="e.g. 1000"
                  value={form.max_discount_per_destination_ngn}
                  onChange={(e) => setForm((f) => ({ ...f, max_discount_per_destination_ngn: e.target.value }))}
                  className="w-full mb-2 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              )}

              {/* Per-verified-phone lifetime cap */}
              <div className="flex items-center justify-between gap-3 py-2">
                <div className="flex-1">
                  <p className="text-[11px] font-bold text-slate-300">Max ₦ per verified phone (lifetime)</p>
                  <p className="text-[9px] text-slate-600">Stronger than the wallet cap — a SIM costs money, unlike a free wallet. Wallets with no verified phone won't qualify while this is on.</p>
                </div>
                <MiniToggle value={capsOn.phone} onChange={(v) => setCapsOn((c) => ({ ...c, phone: v }))} />
              </div>
              {capsOn.phone && (
                <input
                  type="number"
                  placeholder="e.g. 100000"
                  value={form.max_discount_per_phone_ngn}
                  onChange={(e) => setForm((f) => ({ ...f, max_discount_per_phone_ngn: e.target.value }))}
                  className="w-full mb-2 bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              )}

              {/* Total campaign budget cap */}
              <div className="flex items-center justify-between gap-3 py-2">
                <div className="flex-1">
                  <p className="text-[11px] font-bold text-slate-300">Max ₦ total campaign budget</p>
                  <p className="text-[9px] text-slate-600">Campaign automatically stops applying once this much has been given away — no manual deactivation needed.</p>
                </div>
                <MiniToggle value={capsOn.total} onChange={(v) => setCapsOn((c) => ({ ...c, total: v }))} />
              </div>
              {capsOn.total && (
                <input
                  type="number"
                  placeholder="e.g. 500000"
                  value={form.max_total_discount_ngn}
                  onChange={(e) => setForm((f) => ({ ...f, max_total_discount_ngn: e.target.value }))}
                  className="w-full bg-[#111114] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-bold text-slate-100 outline-none focus:border-emerald-700"
                />
              )}
            </div>

            <div className="border-t border-slate-800/60 pt-3">
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
              {saving ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Create campaign (signs with your wallet)'}
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
                {c.max_discount_per_phone_ngn ? ` · max ₦${Number(c.max_discount_per_phone_ngn).toLocaleString()}/phone` : ''}
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
              <MiniToggle value={c.is_active} onChange={() => toggleActive(c)} disabled={saving} />
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
