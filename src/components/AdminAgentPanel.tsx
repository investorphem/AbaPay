"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Bot, ShieldAlert, Loader2, Save } from "lucide-react";

// ⚡ ADMIN — DeAI AGENT CONTROLS
//
// The operator's emergency brakes, now that the agent can actually spend user funds.
// These take effect within ~30 seconds (rules cache TTL) — no redeploy, no contract call.
//
// They layer ON TOP of the on-chain allowance. Even if every switch here were bypassed,
// AbaPayV3 still refuses to spend beyond what each user personally signed for.

interface Props { adminHeaders: Record<string, string>; }

export function AdminAgentPanel({ adminHeaders }: Props) {
  const [settings, setSettings] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/agent', { headers: adminHeaders });
      const data = await res.json();
      if (data.success) { setSettings(data.settings); setStats(data.stats); }
    } catch { /* non-fatal */ }
  }, [adminHeaders]);

  useEffect(() => { load(); }, [load]);

  const save = async (patch: Record<string, any>) => {
    setSaving(true); setMsg('');
    try {
      const res = await fetch('/api/admin/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.success) { setMsg('Saved — live within 30s.'); await load(); }
      else setMsg(data.message || 'Could not save.');
    } catch {
      setMsg('Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="p-6 flex items-center gap-2 text-slate-400">
        <Loader2 size={16} className="animate-spin" /> <span className="text-xs">Loading agent controls…</span>
      </div>
    );
  }

  const Toggle = ({ label, note, value, onChange, danger }: any) => (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-slate-800/60 last:border-0">
      <div className="flex-1">
        <p className={`text-xs font-black ${danger && !value ? 'text-red-400' : 'text-slate-200'}`}>{label}</p>
        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">{note}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        disabled={saving}
        className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${value ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-50`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-7' : 'left-1'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Live stats */}
      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Bot size={16} className="text-emerald-500" />
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">DeAI Agent</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ['Linked users', stats?.linkedChannels ?? 0],
            ['Pending links', stats?.pendingLinks ?? 0],
            ['Schedules', stats?.activeSchedules ?? 0],
            ['Autonomous', stats?.autonomousSchedules ?? 0],
          ].map(([k, v]) => (
            <div key={k as string} className="bg-[#1a1a1f] rounded-xl p-3 border border-slate-800/80">
              <p className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">{k}</p>
              <p className="text-xl font-black text-slate-100 mt-1">{v as number}</p>
            </div>
          ))}
        </div>
        {stats?.byChannel && Object.keys(stats.byChannel).length > 0 && (
          <p className="text-[10px] text-slate-500 mt-3">
            {Object.entries(stats.byChannel).map(([c, n]) => `${c}: ${n}`).join(' · ')}
          </p>
        )}
      </div>

      {/* Kill switches */}
      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5">
        <div className="flex items-center gap-2 mb-1">
          <ShieldAlert size={16} className="text-orange-500" />
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">Emergency controls</h3>
        </div>
        <p className="text-[10px] text-slate-500 mb-2 leading-relaxed">
          Takes effect within 30s. These sit <strong>on top of</strong> the on-chain allowance —
          the contract still bounds every user&apos;s exposure to the amount they personally signed for.
        </p>

        <Toggle
          label="Agent payments"
          note="Master kill. Turns off ALL agent-initiated payments — chat and scheduled. Users can still pay in the app."
          value={settings.agent_enabled}
          onChange={(v: boolean) => save({ agent_enabled: v })}
          danger
        />
        <Toggle
          label="Autonomous execution"
          note="Turns off unattended scheduled payments only. PIN-confirmed chat payments keep working."
          value={settings.agent_autonomous_enabled}
          onChange={(v: boolean) => save({ agent_autonomous_enabled: v })}
          danger
        />
        <Toggle
          label="In-app AI chat"
          note="Shows/hides the assistant widget in the web app. It never moves money — it only fills the form."
          value={settings.ai_chat_enabled}
          onChange={(v: boolean) => save({ ai_chat_enabled: v })}
        />
      </div>

      {/* Caps */}
      <div className="bg-[#111114] rounded-2xl border border-slate-800/60 p-5">
        <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 mb-1">Spend caps</h3>
        <p className="text-[10px] text-slate-500 mb-4 leading-relaxed">
          Bounds the damage from a compromised PIN or relayer key, independently of each user&apos;s own on-chain limit.
        </p>

        <div className="grid sm:grid-cols-2 gap-3">
          {[
            { key: 'agent_max_ngn_per_tx', label: 'Max per transaction (₦)' },
            { key: 'agent_daily_cap_ngn', label: 'Max per user, per day (₦)' },
          ].map(({ key, label }) => (
            <div key={key}>
              <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{label}</label>
              <div className="flex gap-2 mt-1">
                <input
                  type="number"
                  defaultValue={settings[key]}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v !== Number(settings[key])) save({ [key]: v });
                  }}
                  className="flex-1 bg-[#1a1a1f] border border-slate-800/80 rounded-xl px-3 py-2 text-sm font-black text-slate-100 outline-none focus:border-emerald-700"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {msg && (
        <p className="text-[10px] text-emerald-400 flex items-center gap-1.5">
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} {msg}
        </p>
      )}
    </div>
  );
}
