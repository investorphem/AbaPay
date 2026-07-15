"use client";

import React, { useState, useRef, useEffect } from "react";
import { Sparkles, X, Send, Loader2 } from "lucide-react";

// ⚡ IN-APP AI CHAT
//
// Same Claude intent engine, same feasibility rules as the Telegram/WhatsApp/X bots — so
// the app and the bots always agree about what's possible.
//
// CRUCIAL DIFFERENCE: this widget CANNOT move money. There is no PIN and no relayer here.
// The user is already holding their wallet, so the chat's only job is to understand the
// request and PRE-FILL the payment form. The user reviews it and signs, exactly as always.

interface Msg { role: 'user' | 'assistant'; text: string; }

interface Props {
  onPrefill: (prefill: any, schedule?: any) => void;
  onNavigate: (tab: string) => void;
}

export function AIChat({ onPrefill, onNavigate }: Props) {
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();

      setMsgs(m => [...m, { role: 'assistant', text: data.reply || "Sorry, I couldn't process that." }]);

      // The chat never pays — it only fills the form. The user still signs.
      if (data.prefill) {
        onPrefill(data.prefill, data.schedule);
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

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open AI assistant"
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xl shadow-emerald-600/30 flex items-center justify-center transition-all active:scale-95"
      >
        <Sparkles size={22} />
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
