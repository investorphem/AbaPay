"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Bot, Shield, Check, Copy, Trash2, Loader2, AlertTriangle, ExternalLink } from "lucide-react";
import { SUPPORTED_TOKENS } from "@/constants";

const CHANNELS = [
  { id: 'TELEGRAM', name: 'Telegram', color: 'text-sky-500', bot: 'https://t.me/abapayagentbot' },
  { id: 'WHATSAPP', name: 'WhatsApp', color: 'text-emerald-500', bot: 'https://wa.me/2347075418792' },
  { id: 'X', name: 'X (Twitter)', color: 'text-slate-900 dark:text-white', bot: 'https://x.com/AbaPays' },
];

const CHAINS: Array<'CELO' | 'BASE'> = ['CELO', 'BASE'];

function tokensFor(chainName: 'CELO' | 'BASE'): any[] {
  const key = chainName.toLowerCase();
  return (SUPPORTED_TOKENS as any[]).filter((t) => !t.supportedNetworks || t.supportedNetworks.includes(key));
}

// ⚡ The bare bot links above open the chat with nothing pre-filled — the user then has to
// remember and retype the link code themselves. Telegram and WhatsApp both support
// deep-linking a pre-filled first message; X has no equivalent for DMs, so it falls back
// to the bare link (the code stays visible on-screen for the user to paste manually).
function buildChannelLinkUrl(channel: { id: string; bot: string }, linkCode: string | null): string {
  if (!linkCode) return channel.bot;
  if (channel.id === 'TELEGRAM') return `${channel.bot}?start=${encodeURIComponent(linkCode)}`;
  if (channel.id === 'WHATSAPP') return `${channel.bot}?text=${encodeURIComponent(linkCode)}`;
  return channel.bot;
}

interface Props {
  address?: string;
  // Fallback defaults only, for the chain/token selector's initial value — NOT authoritative
  // once the user picks something different here. See onApproveAllowance/onCheckAllowance.
  selectedToken: any;
  activeChainName: string;
  // Called to run the two on-chain approvals (ERC-20 approve + setSpendingAllowance) for
  // WHATEVER chain/token this component's own selector currently has picked — independent of
  // the Pay tab's selector, so approving USDC on Base can never silently depend on the Pay
  // tab happening to show USD₮ on Celo. Returns a result rather than throwing, so this
  // component can show its own confirmation — the page's shared `status` banner only renders
  // inside the Pay tab, never here.
  onApproveAllowance: (amount: string, tokenSymbol: string, chainName: 'CELO' | 'BASE') => Promise<{ success: boolean; message: string } | void>;
  // Reads the on-chain allowance for a given chain/token and updates currentAllowance below.
  onCheckAllowance: (tokenSymbol: string, chainName: 'CELO' | 'BASE') => Promise<string | null>;
  // Current on-chain allowance, in human units, for whatever combo was last checked.
  currentAllowance: string | null;
  isApproving: boolean;
}

export function AgentHub({ address, selectedToken, activeChainName, onApproveAllowance, onCheckAllowance, currentAllowance, isApproving }: Props) {
  const [links, setLinks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [channel, setChannel] = useState('TELEGRAM');
  const [pin, setPin] = useState('');
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [allowanceInput, setAllowanceInput] = useState('10');
  const [approvalResult, setApprovalResult] = useState<{ success: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Independent chain/token selection for THIS approval step — seeded from the Pay tab's
  // current selector as a sensible starting point, but freely changeable here.
  const [approvalChain, setApprovalChain] = useState<'CELO' | 'BASE'>(
    (activeChainName === 'BASE' ? 'BASE' : 'CELO')
  );
  const [approvalTokenSymbol, setApprovalTokenSymbol] = useState<string>(
    selectedToken?.symbol || 'USD₮'
  );

  // Re-check the on-chain allowance whenever the selection (or wallet) changes, so the
  // "Agent can spend up to..." box always reflects the combo currently picked, not stale data
  // from a previous selection.
  useEffect(() => {
    if (!address) return;
    onCheckAllowance(approvalTokenSymbol, approvalChain);
  }, [address, approvalTokenSymbol, approvalChain, onCheckAllowance]);

  // Switching chains may drop the currently selected token if it isn't available there
  // (e.g. USDm is Celo-only) — fall back to the first token that IS available.
  const handleChainChange = (next: 'CELO' | 'BASE') => {
    setApprovalChain(next);
    setApprovalResult(null);
    const available = tokensFor(next);
    if (!available.some((t) => t.symbol === approvalTokenSymbol) && available[0]) {
      setApprovalTokenSymbol(available[0].symbol);
    }
  };

  const handleApproveClick = async () => {
    setApprovalResult(null);
    const result = await onApproveAllowance(allowanceInput, approvalTokenSymbol, approvalChain);
    if (result) setApprovalResult(result);
  };

  const handleCopy = async () => {
    if (!linkCode) return;
    try {
      await navigator.clipboard.writeText(linkCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg('Could not copy — select and copy the code manually.');
    }
  };

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
          // Record whatever was actually approved in Step 1 above, not the Pay tab's
          // unrelated selector — this is what the DeAI agent later reads to decide which
          // token/chain to check an allowance for.
          approved_token: approvalTokenSymbol,
          approved_chain: approvalChain,
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

        {/* Chain + token selector — which combo this approval applies to. */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="grid grid-cols-2 gap-1.5">
            {CHAINS.map((c) => (
              <button
                key={c}
                onClick={() => handleChainChange(c)}
                className={`py-2.5 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                  approvalChain === c
                    ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                    : 'border-slate-100 dark:border-slate-800/80 bg-slate-50 dark:bg-[#1a1a1f] text-slate-500'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className={`grid gap-1.5`} style={{ gridTemplateColumns: `repeat(${tokensFor(approvalChain).length}, minmax(0, 1fr))` }}>
            {tokensFor(approvalChain).map((t: any) => (
              <button
                key={t.symbol}
                onClick={() => { setApprovalTokenSymbol(t.symbol); setApprovalResult(null); }}
                className={`py-2.5 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                  approvalTokenSymbol === t.symbol
                    ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                    : 'border-slate-100 dark:border-slate-800/80 bg-slate-50 dark:bg-[#1a1a1f] text-slate-500'
                }`}
              >
                {t.symbol}
              </button>
            ))}
          </div>
        </div>

        {hasAllowance ? (
          <div className="mb-3 p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/40">
            <p className="text-[10px] uppercase tracking-widest font-black text-emerald-700 dark:text-emerald-400">Agent can spend up to</p>
            <p className="text-2xl font-black text-emerald-700 dark:text-emerald-400">{Number(currentAllowance).toFixed(2)} {approvalTokenSymbol} <span className="text-xs font-bold text-emerald-600/70 dark:text-emerald-400/70">on {approvalChain}</span></p>
          </div>
        ) : (
          <div className="mb-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No limit set for {approvalTokenSymbol} on {approvalChain} — the agent can&apos;t spend anything yet for this combo. It will send you a link to sign instead.
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
            onClick={handleApproveClick}
            disabled={isApproving || !address}
            className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-2xl text-xs font-black uppercase tracking-widest transition-colors active:scale-95 flex items-center gap-2"
          >
            {isApproving ? <><Loader2 size={14} className="animate-spin" /> Signing…</> : 'Approve'}
          </button>
        </div>

        {approvalResult && (
          <p className={`mb-1 text-xs font-bold flex items-center gap-1.5 ${approvalResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-orange-600 dark:text-orange-400'}`}>
            {approvalResult.success ? <Check size={12} /> : <AlertTriangle size={12} />} {approvalResult.message}
          </p>
        )}

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
                onClick={handleCopy}
                className="p-2.5 bg-white dark:bg-[#111114] rounded-xl border border-emerald-100 dark:border-emerald-900/40"
              >
                {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} className="text-emerald-600" />}
              </button>
            </div>
            {copied && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold -mt-2 mb-3">Copied!</p>}
            <a
              href={buildChannelLinkUrl(activeChannel, linkCode)}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-3 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2"
            >
              Open {activeChannel.name} <ExternalLink size={14} />
            </a>
            {activeChannel.id === 'X' && (
              <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">X can&apos;t pre-fill a DM — paste the code above once the chat opens.</p>
            )}
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
