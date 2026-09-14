"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

// ⚡ EVERY CODE BOX ON THIS SITE SHOULD BE COPY-PASTEABLE — that's the whole point of showing
// real request/response JSON and real snippets instead of prose describing them. One small
// client component wrapping each <pre>, rather than making every page a client component just
// to get a button: the pages themselves stay server components (faster, simpler), and this is
// the one island of interactivity each of them needs.
export default function CopyBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can be blocked (permissions, non-HTTPS iframe, older browser) — fail
      // quietly rather than throw an unhandled error over a convenience feature.
    }
  }

  return (
    <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed">
      {label && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800 bg-white/[0.02]">
          <span className="text-slate-400">{label}</span>
          <CopyIconButton copied={copied} onClick={handleCopy} />
        </div>
      )}
      <div className="relative group">
        {!label && (
          <div className="absolute top-2.5 right-2.5 opacity-60 group-hover:opacity-100 transition-opacity">
            <CopyIconButton copied={copied} onClick={handleCopy} />
          </div>
        )}
        <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{code}</pre>
      </div>
    </div>
  );
}

function CopyIconButton({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      type="button"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      title={copied ? "Copied" : "Copy"}
      className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-md border transition-colors ${
        copied
          ? "text-emerald-400 border-emerald-800/60 bg-emerald-900/20"
          : "text-slate-400 border-slate-700 bg-slate-900/60 hover:text-slate-200 hover:border-slate-600"
      }`}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
