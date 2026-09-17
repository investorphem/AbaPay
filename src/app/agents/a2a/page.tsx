import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, ArrowLeft, CheckCircle2 } from "lucide-react";
import CopyBlock from "../CopyBlock";
import ToolTable from "../ToolTable";
import { TOOLS } from "../toolSchemas";

export const metadata: Metadata = {
  title: "A2A — Agents Talking to Agents",
  description: "AbaPay's Agent Card and JSON-RPC endpoint for peer agents — discovery, skills with full parameter reference, and how the linked-wallet PIN works, entirely by API.",
};

export default function A2APage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Peer protocol</span>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">A2A</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          A peer agent discovers AbaPay via its Agent Card, then sends structured tool calls over A2A JSON-RPC — no browser, no human account-creation step, for either side.
        </p>
      </div>

      <section className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Agent Card</div>
          <a href="https://agents.abapays.com/.well-known/agent-card.json" target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-emerald-600 dark:text-emerald-400 hover:underline break-all">agents.abapays.com/.well-known/agent-card.json</a>
        </div>
        <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl p-5">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">JSON-RPC endpoint</div>
          <span className="text-xs font-mono text-slate-600 dark:text-slate-400 break-all">agents.abapays.com/api/a2a</span>
        </div>
      </section>

      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">
        Skills ({TOOLS.length}) — full reference
      </h2>
      <div className="mb-6">
        <ToolTable tools={TOOLS} />
      </div>

      {/* ⚡ THE QUESTION THIS SECTION EXISTS TO ANSWER, DIRECTLY: "can an agent set and use a
          PIN without ever visiting a website?" Yes — and the previous version of this page
          only implied it by omission, which read as uncertainty rather than an answer. Said
          in exactly these words, with the two API calls that make it true. */}
      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">Can an agent set and use a PIN without visiting a website? Yes.</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-5 max-w-2xl">
          The PIN is a field in a JSON body, not something entered into a web form. Linking and every payment after it are both plain API calls:
        </p>
        <div className="space-y-3 mb-5">
          <div className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
            <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
            <div>
              <code className="text-emerald-600 dark:text-emerald-400 font-bold">POST /api/agent/link</code> — a wallet-signature-authenticated call (the same <code className="text-slate-500">personal_sign</code> scheme x402 signing uses elsewhere) that picks the PIN <em>in that same request</em> and mints an Agent Hub api_key back. One HTTP call, no session, no browser.
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
            <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
            <div>
              Every <code className="text-slate-500">pay_bill</code> / <code className="text-slate-500">pay_bill_batch</code> / <code className="text-slate-500">schedule_bill</code> call after that sends the same PIN back as another JSON field — still just an HTTP request.
            </div>
          </div>
        </div>
        <CopyBlock
          label="POST /api/agent/link — real fields, verified live 2026-09-11"
          code={`headers: {
  "x-wallet-address": "0xYourAgentWallet...",
  "x-wallet-signature": "<personal_sign over the request>",
  "x-wallet-timestamp": "1234567890"
}
body: {
  "wallet_address": "0xYourAgentWallet...",
  "channel": "MCP",
  "pin": "1234",
  "approved_chain": "CELO"
}
-> { "success": true, "api_key": "aba_mcp_..." }`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
          Full runnable version: <a href="https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs" className="underline hover:text-emerald-500">examples/agent-quickstart.mjs</a>. Or skip the wire format entirely: <Link href="/agents/sdk" className="underline hover:text-emerald-500">AbaPayAgent.link()</Link> in the SDK does this in one line. CORS is open on this endpoint too — try it straight from a browser.
        </p>
      </section>

      <section className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-[2rem] p-6 sm:p-8 flex items-start gap-3">
        <KeyRound size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed">
          The PIN itself is still real security, not a formality: it&apos;s the one thing separate from the signature that has to be right on <em>every</em> payment call, unlike <Link href="/agents/x402" className="underline">x402</Link>, which needs neither a PIN nor a link step at all. Two different trust models, both entirely API-driven — neither ever requires opening a browser.
        </p>
      </section>
    </>
  );
}
