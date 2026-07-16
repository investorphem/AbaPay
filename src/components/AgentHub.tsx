"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Bot, Shield, Check, Copy, Trash2, Loader2, AlertTriangle, ExternalLink } from "lucide-react";

const CHANNELS = [
  { id: 'TELEGRAM', name: 'Telegram', color: 'text-sky-500', bot: 'https://t.me/abapayagentbot' },
  { id: 'WHATSAPP', name: 'WhatsApp', color: 'text-emerald-500', bot: 'https://wa.me/2347075418792' },
  { id: 'X', name: 'X (Twitter)', color: 'text-slate-900 dark:text-white', bot: 'https://x.com/AbaPays' },
];

interface Props {
  address?: string;
  selectedToken: any;
  activeChainName: string;
  // Called to run the two on-chain approvals (ERC-20 approve + setSpendingAllowance).
  onApproveAllowance: (amount: string) => Promise<void>;
  // Current on-chain allowance, in human units.
  currentAllowance: string | null;
  isApproving: boolean;
}

export function AgentHub({ address, selectedToken, activeChainName, onApproveAllowance, currentAllowance, isApproving }: Props) {
  const [links, setLinks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [channel, setChannel] = useState('TELEGRAM');
  const [pin, setPin] = useState('');
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [allowanceInput, setAllowanceInput] = useState('10');

  const loadLinks = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`/api/agent/link?wallet=${address}`);
      const data = await res.json();
      if (data.success) setLinks(data.links || []);
    } catch { /* non-fatal */ }
  }, [address]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const startLink = async () => {
    if (!address) { setMsg('Connect your wallet first.'); return; }
    if (!/^\d{4,6}$/.test(pin)) { setMsg('PIN must be 4-6 digits.'); return; }

    setLoading(true); setMsg(''); setLinkCode(null);
    try {
      const res = await fetch('/api/agent/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: address,
          channel,
          pin,
          approved_token: selectedToken?.symbol,
          approved_chain: activeChainName,
        }),
      });
      const data = await res.json();
      if (!data.success) { setMsg(data.message || 'Could not start linking.'); return; }

      setLinkCode(data.link_code);
      setPin('');
      loadLinks();
    } catch {
      setMsg('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const unlink = async (id: string) => {
    if (!address) return;
    await fetch('/api/agent/link', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, wallet_address: address }),
    });
    loadLinks();
  };

  const activeChannel = CHANNELS.find(c => c.id === channel)!;
  const hasAllowance = currentAllowance !== null && Number(currentAllowance) > 0;

  return (
    <div className="space-y-4">
      {/* ── HEADER ── */}
      <div className="bg-white dark:bg-[#111114] p-5 rounded-3xl border border-slate-100 dark:border-slate-800/60">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
            <Bot className="text-emerald-600" size={20} />
          </div>
          <div>
            <h3 className="font-black text-slate-900 dark:text-white">DeAI Agent</h3>
            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Pay bills from chat</p>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Link a chat app and approve a spend limit. Then just message the bot — your PIN is the only confirmation needed.
        </p>
      </div>

      {/* ── STEP 1: ON-CHAIN ALLOWANCE (the security boundary) ── */}
      <div className="bg-white dark:bg-[#111114] p-5 rounded-3xl border border-slate-100 dark:border-slate-800/60">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={16} className="text-emerald-600" />
          <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">1. Approve a spend limit</h4>
        </div>

        {hasAllowance ? (
          <div className="mb-3 p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/40">
            <p className="text-[10px] uppercase tracking-widest font-black text-emerald-700 dark:text-emerald-400">Agent can spend up to</p>
            <p className="text-2xl font-black text-emerald-700 dark:text-emerald-400">{Number(currentAllowance).toFixed(2)} {selectedToken?.symbol}</p>
          </div>
        ) : (
          <div className="mb-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No limit set — the agent can&apos;t spend anything yet. It will send you a link to sign instead.
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={allowanceInput}
            onChange={(e) => setAllowanceInput(e.target.value)}
            placeholder="10"
            className="flex-1 bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 rounded-2xl px-4 py-3 font-black text-slate-900 dark:text-white outline-none focus:border-emerald-300"
          />
          <button
            onClick={() => onApproveAllowance(allowanceInput)}
            disabled={isApproving || !address}
            className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-2xl text-xs font-black uppercase tracking-widest transition-colors active:scale-95 flex items-center gap-2"
          >
            {isApproving ? <><Loader2 size={14} className="animate-spin" /> Signing…</> : 'Approve'}
          </button>
        </div>

        <p className="mt-3 text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
          🔒 This limit is enforced <strong>on-chain</strong>, not by our servers. The agent can never spend more than this —
          even if our backend were fully compromised. Set it to 0 any time to revoke instantly.
        </p>
      </div>

      {/* ── STEP 2: LINK A CHANNEL ── */}
      <div className="bg-white dark:bg-[#111114] p-5 rounded-3xl border border-slate-100 dark:border-slate-800/60">
        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mb-3">2. Link a chat app</h4>

        <div className="grid grid-cols-3 gap-2 mb-3">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              onClick={() => { setChannel(c.id); setLinkCode(null); }}
              className={`p-3 rounded-2xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                channel === c.id
                  ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                  : 'border-slate-100 dark:border-slate-800/80 bg-slate-50 dark:bg-[#1a1a1f] text-slate-500'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        {!linkCode ? (
          <>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="Set a 4-6 digit PIN"
              className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 rounded-2xl px-4 py-3 font-black tracking-[0.3em] text-center text-slate-900 dark:text-white outline-none focus:border-emerald-300 mb-2"
            />
            <button
              onClick={startLink}
              disabled={loading || !address}
              className="w-full py-3 bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-200 disabled:opacity-50 text-white dark:text-slate-900 rounded-2xl text-xs font-black uppercase tracking-widest transition-colors active:scale-95 flex items-center justify-center gap-2"
            >
              {loading ? <><Loader2 size={14} className="animate-spin" /> Generating…</> : `Link ${activeChannel.name}`}
            </button>
          </>
        ) : (
          <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/40">
            <p className="text-[10px] uppercase tracking-widest font-black text-emerald-700 dark:text-emerald-400 mb-2">Send this code to the bot</p>
            <div className="flex items-center gap-2 mb-3">
              <code className="flex-1 bg-white dark:bg-[#111114] px-3 py-2 rounded-xl font-mono font-black text-lg text-slate-900 dark:text-white text-center">{linkCode}</code>
              <button
                onClick={() => navigator.clipboard?.writeText(linkCode)}
                className="p-2.5 bg-white dark:bg-[#111114] rounded-xl border border-emerald-100 dark:border-emerald-900/40"
              >
                <Copy size={14} className="text-emerald-600" />
              </button>
            </div>
            <a
              href={activeChannel.bot}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-3 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2"
            >
              Open {activeChannel.name} <ExternalLink size={14} />
            </a>
          </div>
        )}

        {msg && (
          <p className="mt-2 text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1.5">
            <AlertTriangle size={12} /> {msg}
          </p>
        )}
      </div>

      {/* ── LINKED CHANNELS ── */}
      {links.length > 0 && (
        <div className="bg-white dark:bg-[#111114] p-5 rounded-3xl border border-slate-100 dark:border-slate-800/60">
          <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mb-3">Linked</h4>
          <div className="space-y-2">
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-2">
                  {l.link_verified
                    ? <Check size={14} className="text-emerald-600" />
                    : <Loader2 size={14} className="text-slate-400" />}
                  <span className="text-xs font-black text-slate-700 dark:text-slate-300">{l.channel}</span>
                  <span className="text-[10px] text-slate-400 uppercase tracking-widest">
                    {l.link_verified ? 'Active' : 'Awaiting code'}
                  </span>
                </div>
                <button onClick={() => unlink(l.id)} className="p-2 text-slate-400 hover:text-red-500 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-slate-400 leading-relaxed">
            Unlinking stops the chat binding. To fully revoke agent spending, also set your on-chain limit to <strong>0</strong> above.
          </p>
        </div>
      )}
    </div>
  );
}
