"use client";

import React, { useState, useRef, useEffect } from "react";
import { Sparkles, X, Send, Loader2, Check } from "lucide-react";

// ⚡ IN-APP AI CHAT
//
// Same Claude intent engine, same feasibility rules as the Telegram/WhatsApp/X bots — so
// the app and the bots always agree about what's possible.
//
// TWO THINGS THIS CAN DO NOW:
//   1. IMMEDIATE, single recipient — unchanged: returns a `prefill`, the user reviews it in
//      the form and signs themselves. The chat never moves money on its own here.
//   2. FUTURE ("in 10 minutes"), RECURRING ("every Tuesday"), or MULTI-RECIPIENT — these
//      can't be a single "sign now" transaction, so the backend proposes a `scheduleConfirm`
//      instead (same on-chain-allowance model Telegram/WhatsApp/X use). Tapping Approve here
//      commits it via POST /api/schedules, which re-verifies the allowance server-side before
//      creating anything — this widget is just the UI for that confirmation.

interface ScheduleItem {
  serviceCategory: string;
  serviceID: string;
  provider: string | null;
  billersCode: string;
  amountNgn: number;
  meterType?: string;
  /** Each item carries its own chain/token — a batch can mix chains/tokens per recipient. */
  chain: string;
  tokenSymbol: string;
}

interface ScheduleConfirm {
  items: ScheduleItem[];
  runOnceInMinutes?: number;
  recurring?: { frequency: 'daily' | 'weekly' | 'monthly'; dayOfWeek: number | null; dayOfMonth: number | null };
  totalNgn: number;
}

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  scheduleConfirm?: ScheduleConfirm;
  /** Once the user taps Approve (or it fails), the card shows a final state instead of the button. */
  resolved?: 'approved' | 'failed';
}

interface Props {
  onPrefill: (prefill: any) => void;
  onNavigate: (tab: string) => void;
  /** The chat pre-fills a payment the user still has to sign — meaningless without a wallet. */
  walletConnected: boolean;
  /** Called instead of opening the chat when the wallet isn't connected yet. */
  onRequireWallet: () => void;
  /** Sent as a rate-limit key so a connected wallet has its own quota, not just its IP's. */
  walletAddress?: string;
  /** The chain/token currently selected in the Pay tab — used only to check an on-chain
   *  allowance for scheduled/batched payments; irrelevant to the immediate "sign now" flow. */
  chain?: string;
  tokenSymbol?: string;
}

export function AIChat({ onPrefill, onNavigate, walletConnected, onRequireWallet, walletAddress, chain, tokenSymbol }: Props) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'assistant', text: "Hi 👋 Tell me what you'd like to pay — e.g. \"Send ₦500 airtime to 08012345678\" or \"Pay ₦2,000 Ikeja electric, meter 04123456789\"." },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;

    setMsgs(m => [...m, { role: 'user', text }]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch('/api/deai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(walletAddress ? { 'X-Wallet-Address': walletAddress } : {}),
        },
        body: JSON.stringify({ message: text, chain, tokenSymbol }),
      });
      const data = await res.json();

      setMsgs(m => [...m, {
        role: 'assistant',
        text: data.reply || "Sorry, I couldn't process that.",
        scheduleConfirm: data.scheduleConfirm,
      }]);

      // The chat never pays on its own — it only fills the form (user still signs) or, for
      // scheduled/batched requests, proposes a card the user has to explicitly tap Approve on.
      if (data.prefill) {
        onPrefill(data.prefill);
        setTimeout(() => setOpen(false), 1200);
      } else if (data.navigate) {
        onNavigate(data.navigate);
        setTimeout(() => setOpen(false), 1200);
      }
    } catch {
      setMsgs(m => [...m, { role: 'assistant', text: 'Something went wrong. Please try again.' }]);
    } finally {
      setBusy(false);
    }
  };

  const approveSchedule = async (msgIndex: number, confirm: ScheduleConfirm) => {
    if (!walletAddress) return;
    setBusy(true);
    try {
      const batchId = confirm.items.length > 1 ? crypto.randomUUID() : undefined;
      const runOnceAt = confirm.runOnceInMinutes
        ? new Date(Date.now() + confirm.runOnceInMinutes * 60_000).toISOString()
        : undefined;

      const results = await Promise.all(confirm.items.map((item) =>
        fetch('/api/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet_address: walletAddress,
            service_id: item.serviceID,
            service_category: item.serviceCategory,
            provider: item.provider,
            billers_code: item.billersCode,
            amount_ngn: item.amountNgn,
            meter_type: item.meterType,
            blockchain: item.chain,
            token_used: item.tokenSymbol,
            auto_execute: true,
            batch_id: batchId,
            ...(runOnceAt
              ? { frequency: 'once', run_once_at: runOnceAt }
              : confirm.recurring
                ? { frequency: confirm.recurring.frequency, day_of_week: confirm.recurring.dayOfWeek, day_of_month: confirm.recurring.dayOfMonth }
                : { frequency: 'once', run_once_at: new Date(Date.now() + 60_000).toISOString() }),
          }),
        }).then(r => r.json())
      ));

      const allOk = results.every(r => r.success);
      setMsgs(m => m.map((msg, i) => i === msgIndex ? { ...msg, resolved: allOk ? 'approved' : 'failed' } : msg));
      setMsgs(m => [...m, {
        role: 'assistant',
        text: allOk
          ? `✅ Approved — ${confirm.items.length > 1 ? `all ${confirm.items.length} payments are` : 'this is'} scheduled. I'll message you here once ${confirm.items.length > 1 ? 'they run' : 'it runs'}.`
          : `⚠️ ${results.find(r => !r.success)?.message || "Couldn't schedule that — please try again."}`,
      }]);
    } catch {
      setMsgs(m => m.map((msg, i) => i === msgIndex ? { ...msg, resolved: 'failed' } : msg));
      setMsgs(m => [...m, { role: 'assistant', text: '⚠️ Something went wrong scheduling that. Please try again.' }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => walletConnected ? setOpen(true) : onRequireWallet()}
        aria-label="Open AI assistant"
        className="fixed bottom-24 right-4 sm:bottom-6 sm:right-6 z-40 w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xl shadow-emerald-600/30 flex items-center justify-center transition-all active:scale-95"
      >
        <Sparkles size={22} />
        {/* Blinking "new feature" notifier — draws the eye without blocking the icon */}
        <span className="absolute -top-1 -right-1 flex h-4 w-4">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75"></span>
          <span className="relative inline-flex h-4 w-4 rounded-full bg-red-600 border-2 border-white dark:border-[#111114]"></span>
        </span>
      </button>
    );
  }

  return (
    <div className="fixed inset-x-4 bottom-4 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[380px] z-40 bg-white dark:bg-[#111114] rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[70vh] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
            <Sparkles size={15} className="text-emerald-600" />
          </div>
          <div>
            <p className="text-xs font-black text-slate-900 dark:text-white leading-none">DeAI Assistant</p>
            <p className="text-[9px] uppercase tracking-widest text-slate-400 font-bold mt-0.5">Fills the form — you sign</p>
          </div>
        </div>
        <button onClick={() => setOpen(false)} className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
          <X size={18} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed whitespace-pre-line ${
                m.role === 'user'
                  ? 'bg-emerald-600 text-white rounded-br-md'
                  : 'bg-slate-50 dark:bg-[#1a1a1f] text-slate-700 dark:text-slate-300 rounded-bl-md'
              }`}
            >
              {m.text}
              {m.scheduleConfirm && (
                <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700/60">
                  {m.resolved ? (
                    <div className={`flex items-center gap-1.5 text-[11px] font-black ${m.resolved === 'approved' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                      {m.resolved === 'approved' ? <><Check size={12} /> Approved</> : 'Not scheduled'}
                    </div>
                  ) : (
                    <button
                      onClick={() => approveSchedule(i, m.scheduleConfirm!)}
                      disabled={busy}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[11px] font-black py-2 rounded-xl transition-colors active:scale-95"
                    >
                      Approve
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-slate-50 dark:bg-[#1a1a1f] px-3.5 py-2.5 rounded-2xl rounded-bl-md">
              <Loader2 size={14} className="animate-spin text-slate-400" />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-slate-100 dark:border-slate-800 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Tell me what to pay…"
          disabled={busy}
          className="flex-1 bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 rounded-2xl px-4 py-2.5 text-xs text-slate-900 dark:text-white outline-none focus:border-emerald-300 disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="w-10 h-10 rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white flex items-center justify-center transition-colors active:scale-95 shrink-0"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
