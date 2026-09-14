"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

// ⚡ ONE STEP OF A REAL TERMINAL SESSION — a $ prompt with the exact command, and the real
// response underneath. The copy button copies ONLY the command (not the decorative "$" or the
// response) — that's the one line someone actually wants on their clipboard to paste into
// their own shell.
export default function TerminalStep({ cmd, output, note }: { cmd: string; output?: string; note?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — fail quietly */
    }
  }

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <div className="flex items-start gap-2 group">
        <span className="text-emerald-500 select-none flex-shrink-0 mt-[1px]">$</span>
        <span className="text-slate-200 flex-1 whitespace-pre-wrap break-all">{cmd}</span>
        <button
          onClick={handleCopy}
          type="button"
          aria-label={copied ? "Copied" : "Copy command"}
          title={copied ? "Copied" : "Copy command"}
          className={`flex-shrink-0 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors opacity-60 group-hover:opacity-100 ${
            copied
              ? "text-emerald-400 border-emerald-800/60 bg-emerald-900/20"
              : "text-slate-500 border-slate-700 bg-slate-900/60 hover:text-slate-300 hover:border-slate-600"
          }`}
        >
          {copied ? <Check size={9} /> : <Copy size={9} />}
        </button>
      </div>
      {output && <div className="text-slate-500 mt-1.5 pl-4 whitespace-pre-wrap">{output}</div>}
      {note && <div className="text-slate-600 mt-1 pl-4 italic">{note}</div>}
    </div>
  );
}
