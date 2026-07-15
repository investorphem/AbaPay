"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Banknote, LifeBuoy, Loader2, Check, X, Send, ExternalLink } from "lucide-react";

// ⚡ ADMIN — REFUNDS & SUPPORT
//
// REFUNDS: failed vends are auto-queued. The operator reviews and refunds from THEIR OWN
// wallet — the browser signs refundUser() on-chain, and the backend VERIFIES that
// transaction before marking anyone as paid.
//
// Why a human stays in the loop: refundUser() is onlyOwner by design. Giving the relayer
// hot key the power to send vault funds to arbitrary addresses would turn a bounded, capped
// key into one that can drain the treasury. Money entering the vault is capped on-chain and
// safe to automate; money leaving it is not.

interface Props {
  adminHeaders: Record<string, string>;
  /** Signs refundUser() from the admin's own wallet. Returns the tx hash. */
  onExecuteRefund: (r: any) => Promise<string | null>;
}

export function AdminOpsPanel({ adminHeaders, onExecuteRefund }: Props) {
  const [view, setView] = useState<'refunds' | 'support'>('refunds');
  const [refunds, setRefunds] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        fetch('/api/admin/refunds?status=PENDING', { headers: adminHeaders }).then(x => x.json()),
        fetch('/api/admin/support?status=OPEN', { headers: adminHeaders }).then(x => x.json()),
      ]);
      if (r.success) { setRefunds(r.refunds); setSummary((p: any) => ({ ...p, ...r.summary })); }
      if (s.success) { setTickets(s.tickets); setSummary((p: any) => ({ ...p, ...s.summary })); }
    } catch { /* non-fatal */ }
  }, [adminHeaders]);

  useEffect(() => { load(); }, [load]);

  const doRefund = async (r: any) => {
    setBusyId(r.id); setMsg('');
    try {
      // 1) Admin's own wallet signs the on-chain refund.
      const hash = await onExecuteRefund(r);
      if (!hash) { setMsg('Refund cancelled or failed in wallet.'); return; }

      // 2) Backend VERIFIES it on-chain before recording it.
      const res = await fetch('/api/admin/refunds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ id: r.id, refund_tx_hash: hash }),
      });
      const data = await res.json();
      setMsg(data.message);
      if (data.success) await load();
    } catch (e: any) {
      setMsg(e?.shortMessage || 'Refund failed.');
    } finally {
      setBusyId(null);
    }
  };

  const rejectRefund = async (r: any) => {
    setBusyId(r.id);
    await fetch('/api/admin/refunds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ id: r.id, action: 'REJECT', notes: 'Rejected by operator' }),
    });
    await load();
    setBusyId(null);
  };

  const sendReply = async (t: any, close = false) => {
    const reply = replies[t.id];
    if (!reply?.trim()) return;
    setBusyId(t.id);
    const res = await fetch('/api/admin/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ id: t.id, reply, close }),
    });
    const data = await res.json();
    setMsg(data.message);
    setReplies(p => ({ ...p, [t.id]: '' }));
    await load();
    setBusyId(null);
  };

  const channelIcon = (c: string) =>
    c === 'TELEGRAM' ? '💬 Telegram' : c === 'WHATSAPP' ? '💬 WhatsApp' : c === 'X' ? '💬 X' : c === 'SCHEDULE' ? '🤖 Schedule' : '🌐 Web';

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-2">
        {(['refunds', 'support'] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`flex-1 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
              view === v ? 'bg-emerald-600 text-white' : 'bg-[#1a1a1f] text-slate-400 border border-slate-800/80'
            }`}
          >
            {v === 'refunds' ? <Banknote size={14} /> : <LifeBuoy size={14} />}
            {v}
            {v === 'refunds' && summary.pendingCount > 0 && (
              <span className="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded-full">{summary.pendingCount}</span>
            )}
            {v === 'support' && summary.openCount > 0 && (
              <span className="bg-orange-500 text-white text-[9px] px-1.5 py-0.5 rounded-full">{summary.openCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* REFUNDS */}
      {view === 'refunds' && (
        <div className="space-y-3">
          {summary.totalOwedNgn > 0 && (
            <div className="bg-red-500/10 border border-red-900/40 rounded-2xl p-4">
              <p className="text-[10px] uppercase tracking-widest font-black text-red-400">Owed to users</p>
              <p className="text-2xl font-black text-red-400">₦{Number(summary.totalOwedNgn).toLocaleString()}</p>
            </div>
          )}

          {refunds.length === 0 && (
            <div className="bg-[#111114] border border-slate-800/60 rounded-2xl p-8 text-center">
              <Check size={24} className="text-emerald-500 mx-auto mb-2" />
              <p className="text-xs text-slate-400">No pending refunds. Everyone&apos;s square.</p>
            </div>
          )}

          {refunds.map(r => (
            <div key={r.id} className="bg-[#111114] border border-slate-800/60 rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{channelIcon(r.source_channel)} · {r.service_category}</p>
                  <p className="text-lg font-black text-slate-100 mt-0.5">
                    {Number(r.amount_crypto).toFixed(4)} {r.token_used}
                    {r.amount_naira ? <span className="text-xs text-slate-500 font-bold ml-2">₦{Number(r.amount_naira).toLocaleString()}</span> : null}
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono mt-1 truncate">{r.wallet_address}</p>
                  <p className="text-[10px] text-orange-400 mt-1">{r.vtpass_error || r.reason}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => doRefund(r)}
                  disabled={busyId === r.id}
                  className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"
                >
                  {busyId === r.id ? <Loader2 size={12} className="animate-spin" /> : <Banknote size={12} />}
                  Refund now
                </button>
                <button
                  onClick={() => rejectRefund(r)}
                  disabled={busyId === r.id}
                  className="px-4 py-2.5 bg-[#1a1a1f] border border-slate-800/80 text-slate-400 rounded-xl text-[10px] font-black uppercase tracking-widest"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SUPPORT */}
      {view === 'support' && (
        <div className="space-y-3">
          {tickets.length === 0 && (
            <div className="bg-[#111114] border border-slate-800/60 rounded-2xl p-8 text-center">
              <Check size={24} className="text-emerald-500 mx-auto mb-2" />
              <p className="text-xs text-slate-400">No open tickets.</p>
            </div>
          )}

          {tickets.map(t => (
            <div key={t.id} className="bg-[#111114] border border-slate-800/60 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{channelIcon(t.channel)}</p>
                <p className="text-[9px] text-slate-600">{new Date(t.created_at).toLocaleString()}</p>
              </div>

              <p className="text-xs text-slate-200 leading-relaxed mb-2 whitespace-pre-line">{t.message}</p>

              {t.tx_hash && (
                <p className="text-[10px] text-slate-500 font-mono mb-3 flex items-center gap-1 truncate">
                  <ExternalLink size={10} /> {t.tx_hash}
                </p>
              )}

              <textarea
                value={replies[t.id] || ''}
                onChange={(e) => setReplies(p => ({ ...p, [t.id]: e.target.value }))}
                placeholder={`Reply — delivered to their ${t.channel.toLowerCase()}…`}
                rows={2}
                className="w-full bg-[#1a1a1f] border border-slate-800/80 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-emerald-700 mb-2"
              />

              <div className="flex gap-2">
                <button
                  onClick={() => sendReply(t)}
                  disabled={busyId === t.id || !replies[t.id]?.trim()}
                  className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"
                >
                  {busyId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Reply
                </button>
                <button
                  onClick={() => sendReply(t, true)}
                  disabled={busyId === t.id || !replies[t.id]?.trim()}
                  className="px-4 py-2.5 bg-[#1a1a1f] border border-slate-800/80 text-slate-400 rounded-xl text-[10px] font-black uppercase tracking-widest"
                >
                  Reply &amp; close
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {msg && <p className="text-[10px] text-emerald-400">{msg}</p>}
    </div>
  );
}
