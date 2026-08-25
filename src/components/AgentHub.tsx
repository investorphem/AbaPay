"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Bot, Shield, Check, Copy, Trash2, Loader2, AlertTriangle, ExternalLink, KeyRound } from "lucide-react";
import { normalizeChainName, tokensForChain, defaultTokenForChain, type ChainName } from "@/constants";

const CHANNELS = [
  { id: 'TELEGRAM', name: 'Telegram', color: 'text-sky-500', bot: 'https://t.me/abapayagentbot' },
  { id: 'WHATSAPP', name: 'WhatsApp', color: 'text-emerald-500', bot: 'https://wa.me/2347075418792' },
  { id: 'X', name: 'X (Twitter)', color: 'text-slate-900 dark:text-white', bot: 'https://x.com/AbaPays' },
  // No bot to message — an MCP client (Claude, or any MCP-speaking AI agent) authenticates
  // with an API key instead of a claimed chat identity. See startLink()'s MCP branch below.
  { id: 'MCP', name: 'MCP (AI Agents)', color: 'text-violet-500', bot: '' },
];

// Base first — it's the app's default chain, so it's the one this picker should open on.
const CHAINS: ChainName[] = ['BASE', 'CELO'];

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
  onApproveAllowance: (amount: string, tokenSymbol: string, chainName: ChainName) => Promise<{ success: boolean; message: string } | void>;
  // Reads the on-chain allowance for a given chain/token and updates currentAllowance below.
  onCheckAllowance: (tokenSymbol: string, chainName: ChainName) => Promise<string | null>;
  // Current on-chain allowance, in human units, for whatever combo was last checked.
  currentAllowance: string | null;
  isApproving: boolean;
  // Signs a message with whichever wallet client is actually live for the current
  // environment (plain web/wagmi, MiniPay, or a Farcaster Mini App) and returns the
  // signature, or null if signing isn't possible/was rejected. Deliberately NOT wagmi's
  // useWalletClient() here — MiniPay and the Farcaster Mini App both bypass wagmi entirely,
  // so that hook returns undefined in those two environments even when the wallet is
  // genuinely connected. The caller (page.tsx) owns the environment detection; this
  // component only needs "give me a signature for this string."
  onSignMessage: (message: string) => Promise<string | null>;
}

export function AgentHub({ address, selectedToken, activeChainName, onApproveAllowance, onCheckAllowance, currentAllowance, isApproving, onSignMessage }: Props) {
  // 🔐 Every wallet-scoped mutation below (start a link, change/reset a PIN, unlink) must
  // prove the connected wallet actually holds this address's private key — a bare address
  // string proves nothing, since addresses are public. Signs a short-lived, timestamped
  // message fresh for each action (not a cached session) so a wallet popup only ever appears
  // right when the user deliberately clicks something sensitive. See src/utils/walletAuth.ts.
  //
  // `action` must be the exact "METHOD:/api/path" string the server verifies against
  // (walletAuth.ts binds the signature to it) — a signature signed for one action/endpoint is
  // rejected if replayed against another, so this can't be a generic fixed string anymore.
  const getAuthHeaders = async (action: string): Promise<Record<string, string> | null> => {
    if (!address) return null;
    const timestamp = Date.now().toString();
    const signature = await onSignMessage(`AbaPay Agent Action: ${action}: ${timestamp}`);
    if (!signature) return null;
    return { 'x-wallet-signature': signature, 'x-wallet-timestamp': timestamp };
  };

  const [links, setLinks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [channel, setChannel] = useState('TELEGRAM');
  const [pin, setPin] = useState('');
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [mcpKeyLabel, setMcpKeyLabel] = useState('');
  const [msg, setMsg] = useState('');
  const [allowanceInput, setAllowanceInput] = useState('10');
  const [approvalResult, setApprovalResult] = useState<{ success: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Independent chain/token selection for THIS approval step — seeded from the Pay tab's
  // current selector as a sensible starting point, but freely changeable here.
  const [approvalChain, setApprovalChain] = useState<ChainName>(
    () => normalizeChainName(activeChainName)
  );
  // Falls back to whatever THAT chain leads with (USDC on Base, USD₮ on Celo) rather than to
  // a hardcoded symbol, so an unset Pay-tab selection can't seed this with a token the chain
  // doesn't even offer.
  const [approvalTokenSymbol, setApprovalTokenSymbol] = useState<string>(
    () => selectedToken?.symbol || defaultTokenForChain(normalizeChainName(activeChainName)).symbol
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
  const handleChainChange = (next: ChainName) => {
    setApprovalChain(next);
    setApprovalResult(null);
    const available = tokensForChain(next);
    if (!available.some((t) => t.symbol === approvalTokenSymbol) && available[0]) {
      setApprovalTokenSymbol(available[0].symbol);
    }
  };

  const handleApproveClick = async () => {
    setApprovalResult(null);
    const result = await onApproveAllowance(allowanceInput, approvalTokenSymbol, approvalChain);
    if (result) setApprovalResult(result);
  };

  /**
   * The URL an MCP client needs, taken from the origin the user is actually on.
   *
   * Read from `window.location` rather than a build-time constant so a preview deployment hands
   * out its own URL instead of production's — a copied URL that points somewhere else is worse
   * than none, because it fails with the client's credentials looking like the problem. Falls
   * back to the canonical domain during SSR, where there is no origin to read.
   */
  const mcpServerUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/mcp`
    : 'https://abapays.com/api/mcp';

  const handleCopy = async (text?: string | null) => {
    const value = text ?? linkCode;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg('Could not copy — select and copy it manually.');
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

    setLoading(true); setMsg(''); setLinkCode(null); setApiKey(null);
    try {
      const authHeaders = await getAuthHeaders('POST:/api/agent/link');
      if (!authHeaders) { setMsg('Signature request was rejected or failed — please try again.'); return; }

      const res = await fetch('/api/agent/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          wallet_address: address,
          channel,
          pin,
          // Record whatever was actually approved in Step 1 above, not the Pay tab's
          // unrelated selector — this is what the DeAI agent later reads to decide which
          // token/chain to check an allowance for.
          approved_token: approvalTokenSymbol,
          approved_chain: approvalChain,
          ...(channel === 'MCP' ? { mcp_key_label: mcpKeyLabel || undefined } : {}),
        }),
      });
      const data = await res.json();
      if (!data.success) { setMsg(data.message || 'Could not start linking.'); return; }

      if (channel === 'MCP') {
        setApiKey(data.api_key);
        setMcpKeyLabel('');
      } else {
        setLinkCode(data.link_code);
      }
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
    const authHeaders = await getAuthHeaders('DELETE:/api/agent/link');
    if (!authHeaders) { setMsg('Signature request was rejected or failed — please try again.'); return; }

    await fetch('/api/agent/link', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ id, wallet_address: address }),
    });
    loadLinks();
  };

  // ⚡ CHANGE / FORGOT PIN — same thing either way: your wallet connection here already
  // proves ownership, so there's no "old PIN" to ask for. Tracked per-row so only one link's
  // form is open at a time.
  const [pinEditId, setPinEditId] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const [pinMsg, setPinMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [savingPin, setSavingPin] = useState(false);

  const savePin = async (id: string) => {
    if (!address) return;
    if (!/^\d{4,6}$/.test(newPin)) { setPinMsg({ id, text: 'PIN must be 4-6 digits.', ok: false }); return; }
    setSavingPin(true);
    try {
      const authHeaders = await getAuthHeaders('PATCH:/api/agent/link');
      if (!authHeaders) { setPinMsg({ id, text: 'Signature request was rejected or failed — please try again.', ok: false }); return; }

      const res = await fetch('/api/agent/link', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ id, wallet_address: address, new_pin: newPin }),
      });
      const data = await res.json();
      if (data.success) {
        setPinMsg({ id, text: 'PIN updated.', ok: true });
        setNewPin('');
        setTimeout(() => { setPinEditId(null); setPinMsg(null); }, 1500);
      } else {
        setPinMsg({ id, text: data.message || 'Could not update PIN.', ok: false });
      }
    } catch {
      setPinMsg({ id, text: 'Something went wrong.', ok: false });
    } finally {
      setSavingPin(false);
    }
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
          <div className={`grid gap-1.5`} style={{ gridTemplateColumns: `repeat(${tokensForChain(approvalChain).length}, minmax(0, 1fr))` }}>
            {tokensForChain(approvalChain).map((t: any) => (
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

        {/* 🔴 WITH NO WALLET CONNECTED WE KNOW NOTHING — SO SAY NOTHING, RATHER THAN "NO LIMIT SET".
            An allowance lives on chain against a specific address. With no address there is no
            allowance to have an opinion about, and the "the agent can't spend anything yet"
            branch below was being rendered anyway: a positive claim about the chain made from an
            unread state. That matters most in the one case where someone would come looking —
            checking whether an agent is still authorised to spend — where it would reassure them
            wrongly. Not connected is its own state, and it asks rather than asserts. */}
        {!address ? (
          <div className="mb-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Connect your wallet to see whether the agent has a spending limit for {approvalTokenSymbol} on {approvalChain}. Any limit you set previously stays live on chain until you change it — connecting or disconnecting here doesn&apos;t affect it.
            </p>
          </div>
        ) : hasAllowance ? (
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
        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300 mb-3">2. Link a chat app or AI agent</h4>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              onClick={() => { setChannel(c.id); setLinkCode(null); setApiKey(null); setMsg(''); }}
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

        {channel === 'MCP' && !apiKey && (
          <p className="text-[10px] text-slate-400 leading-relaxed mb-2">
            For AI agents (Claude, or any MCP-speaking client) to check balances and pay bills on your behalf. Same PIN + on-chain limit protection as the chat channels.
          </p>
        )}

        {/*
          ⚡ HOW TO ACTUALLY REACH THIS CHANNEL — ALWAYS, NOT ONLY MID-LINK.
          🔴 The "Open {channel}" button lived INSIDE the link-code block, so it existed only
          during an active linking flow and disappeared the moment linking finished. A user who
          had linked WhatsApp weeks ago, or who never had the bot saved in the first place, had
          nothing anywhere in the app that would take them to it — the channel was set up and
          unreachable. MCP was worse: an API key with no server URL beside it is not something a
          user can act on at all, since the URL is the one thing their client actually needs.
          Both now live here, beside the channel they belong to, whatever state linking is in.
        */}
        {/* Hidden mid-link on a chat channel: the flow below already shows the same button as its
            primary call to action, with the code pre-filled, and two of them side by side reads
            as two different destinations. MCP has no such step, so its URL is always shown. */}
        <div className={`mb-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 ${linkCode && channel !== 'MCP' ? 'hidden' : ''}`}>
          {channel === 'MCP' ? (
            <>
              <p className="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1.5">MCP server URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white dark:bg-[#111114] px-3 py-2 rounded-xl font-mono font-bold text-[11px] text-slate-900 dark:text-white break-all">{mcpServerUrl}</code>
                <button
                  onClick={() => handleCopy(mcpServerUrl)}
                  title="Copy the MCP server URL"
                  className="p-2.5 bg-white dark:bg-[#111114] rounded-xl border border-slate-100 dark:border-slate-800/80 shrink-0"
                >
                  {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} className="text-slate-500" />}
                </button>
              </div>
              <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                Add this as the AbaPay server in your MCP client, then authorise it in the browser — or paste an API key created below. Either way it asks for your PIN on every payment.
              </p>
            </>
          ) : (
            <>
              <p className="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1.5">Open the {activeChannel.name} bot</p>
              <a
                href={buildChannelLinkUrl(activeChannel, linkCode)}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-2.5 bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/80 rounded-xl text-[11px] font-black text-slate-700 dark:text-slate-200 flex items-center justify-center gap-2 transition-colors hover:border-emerald-300 dark:hover:border-emerald-700"
              >
                {activeChannel.name} <ExternalLink size={12} />
              </a>
              <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                Lost the chat, or on a new phone? This opens it again — you don&apos;t need to re-link.
              </p>
            </>
          )}
        </div>

        {!linkCode && !apiKey ? (
          <>
            {channel === 'MCP' && (
              <input
                type="text"
                value={mcpKeyLabel}
                onChange={(e) => setMcpKeyLabel(e.target.value.slice(0, 60))}
                placeholder="Label (e.g. Claude Desktop) — optional"
                className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 rounded-2xl px-4 py-3 text-sm text-slate-900 dark:text-white outline-none focus:border-emerald-300 mb-2"
              />
            )}
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
              {loading
                ? <><Loader2 size={14} className="animate-spin" /> Generating…</>
                : channel === 'MCP' ? 'Create API Key' : `Link ${activeChannel.name}`}
            </button>
          </>
        ) : apiKey ? (
          <div className="p-4 rounded-2xl bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-900/40">
            <p className="text-[10px] uppercase tracking-widest font-black text-violet-700 dark:text-violet-400 mb-2">
              Save this API key now — it won&apos;t be shown again
            </p>
            <div className="flex items-center gap-2 mb-3">
              <code className="flex-1 bg-white dark:bg-[#111114] px-3 py-2 rounded-xl font-mono font-bold text-[11px] text-slate-900 dark:text-white break-all">{apiKey}</code>
              <button
                onClick={() => handleCopy(apiKey)}
                className="p-2.5 bg-white dark:bg-[#111114] rounded-xl border border-violet-100 dark:border-violet-900/40 shrink-0"
              >
                {copied ? <Check size={14} className="text-violet-600" /> : <Copy size={14} className="text-violet-600" />}
              </button>
            </div>
            {copied && <p className="text-[10px] text-violet-600 dark:text-violet-400 font-bold -mt-2 mb-3">Copied!</p>}
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Give this to your MCP client as the AbaPay server credential, along with your PIN. Revoke it any time from the Linked list below.
            </p>
          </div>
        ) : (
          <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/40">
            <p className="text-[10px] uppercase tracking-widest font-black text-emerald-700 dark:text-emerald-400 mb-2">Send this code to the bot</p>
            <div className="flex items-center gap-2 mb-3">
              <code className="flex-1 bg-white dark:bg-[#111114] px-3 py-2 rounded-xl font-mono font-black text-lg text-slate-900 dark:text-white text-center">{linkCode}</code>
              <button
                onClick={() => handleCopy()}
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
              <div key={l.id} className="p-3 rounded-2xl bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {l.link_verified
                      ? <Check size={14} className="text-emerald-600" />
                      : <Loader2 size={14} className="text-slate-400" />}
                    <span className="text-xs font-black text-slate-700 dark:text-slate-300">
                      {l.channel}{l.channel === 'MCP' && l.mcp_key_label ? ` · ${l.mcp_key_label}` : ''}
                    </span>
                    <span className="text-[10px] text-slate-400 uppercase tracking-widest">
                      {l.link_verified ? 'Active' : 'Awaiting code'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setPinEditId(pinEditId === l.id ? null : l.id); setNewPin(''); setPinMsg(null); }}
                      className="p-2 text-slate-400 hover:text-emerald-600 transition-colors"
                      title="Change PIN"
                    >
                      <KeyRound size={14} />
                    </button>
                    <button onClick={() => unlink(l.id)} className="p-2 text-slate-400 hover:text-red-500 transition-colors" title="Unlink">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {pinEditId === l.id && (
                  <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-2">
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      Forgot your PIN or just want to change it — set a new one below. Your wallet connection here is all the verification needed; the old PIN isn't required.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="New 4-6 digit PIN"
                        className="flex-1 px-3 py-2 rounded-xl bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-white outline-none focus:border-emerald-400"
                      />
                      <button
                        onClick={() => savePin(l.id)}
                        disabled={savingPin}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors active:scale-95"
                      >
                        {savingPin ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                      </button>
                    </div>
                    {pinMsg && pinMsg.id === l.id && (
                      <p className={`text-[10px] font-bold ${pinMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{pinMsg.text}</p>
                    )}
                  </div>
                )}
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
