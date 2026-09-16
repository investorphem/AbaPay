import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FolderGit2, Puzzle, CheckCircle2 } from "lucide-react";
import CopyBlock from "../CopyBlock";
import TerminalStep from "../TerminalStep";
import X402Playground from "../X402Playground";
import MCPPlayground from "../MCPPlayground";

export const metadata: Metadata = {
  title: "Install AbaPay as a Skill",
  description: "Step-by-step: install AbaPay as a real skill in your agent host, then make an actual bill payment through it — with live simulations, not just text.",
};

export default function SkillPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Install</span>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">Install AbaPay as a skill</h1>
          <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
            One command adds AbaPay to any agent host that speaks the <code className="text-slate-500">skills</code> convention (Claude Code included). Everything below is real — the same live server the rest of this site demos.
          </p>
        </div>
        <a href="/skill.md" target="_blank" rel="noopener noreferrer" title="View the raw skill file — this is what the installer actually fetches" className="p-2 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
          <FolderGit2 size={20} />
        </a>
      </div>

      {/* ── STEP 1 ── */}
      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-7 h-7 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-xs font-black flex items-center justify-center flex-shrink-0">1</span>
          <h2 className="font-black text-slate-900 dark:text-white">Install the skill</h2>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4 max-w-2xl">
          From a terminal, in any project where your agent (Claude Code, or another <code className="text-slate-500">skills</code>-aware host) runs:
        </p>
        <CopyBlock label="Terminal" code={`npx skills add https://agents.abapays.com`} />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
          This fetches <Link href="/skill.md" className="underline hover:text-emerald-500">agents.abapays.com/skill.md</Link> — the same convention <code className="text-slate-500">celo-builders</code> and other real skills use. Claude Code drops it into <code className="text-slate-500">.claude/skills/</code> automatically; no config to hand-edit.
        </p>
      </section>

      {/* ── STEP 2 ── */}
      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-7 h-7 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-xs font-black flex items-center justify-center flex-shrink-0">2</span>
          <h2 className="font-black text-slate-900 dark:text-white">Just ask, in plain language</h2>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4 max-w-2xl">
          No new syntax to learn — once installed, your agent reads the skill and knows both paths in. Try prompts like these:
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          {[
            "Pay ₦1000 of MTN airtime to 08012345678 using AbaPay's x402 rail from my wallet.",
            "Link my wallet to AbaPay with PIN 1234, then check my USDT balance on Celo.",
            "Using AbaPay, pay my DSTV cable bill and my electricity bill in one batch.",
            "Set up a monthly AbaPay schedule for ₦2000 MTN data on the 1st of each month.",
          ].map((prompt) => (
            <div key={prompt} className="bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-slate-800/60 rounded-xl p-4 text-sm text-slate-600 dark:text-slate-300 italic">
              &ldquo;{prompt}&rdquo;
            </div>
          ))}
        </div>
      </section>

      {/* ── STEP 3: LIVE SIMULATION, x402 ── */}
      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2 flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-xs font-black flex items-center justify-center flex-shrink-0">3</span>
        See it work — zero setup (x402)
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 px-2 max-w-2xl">
        This is exactly what your agent does after step 2 for the zero-setup path — no account, no PIN. Edit the bill and send it for real; it&apos;s a live probe against production, so it always returns a genuine price.
      </p>
      <div className="mb-6">
        <X402Playground />
      </div>

      {/* ── STEP 4: LIVE SIMULATION, MCP ── */}
      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2 flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-xs font-black flex items-center justify-center flex-shrink-0">4</span>
        See it work — linked wallet (MCP)
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 px-2 max-w-2xl">
        For the fuller tool catalog, your agent calls these same 10 tools. Read-only ones below send for real; <code className="text-slate-500">pay_bill</code> and friends show the exact request instead — never fired from a public page.
      </p>
      <div className="mb-6">
        <MCPPlayground />
      </div>

      {/* ── STEP 5: THE REAL SESSION, END TO END ── */}
      <section className="bg-[#0b0d0f] rounded-[2rem] border border-slate-800 overflow-hidden mb-6">
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-white/[0.02]">
          <span className="text-slate-400 text-xs font-mono tracking-wider">first real payment — end to end</span>
          <span className="flex items-center gap-1.5 text-emerald-400 font-bold text-[10px] uppercase tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Real session
          </span>
        </div>
        <div className="p-6 space-y-4">
          <TerminalStep cmd="npx skills add https://agents.abapays.com" />
          <div className="pl-4 border-l-2 border-slate-800 space-y-3 font-mono text-[12px]">
            <div className="text-slate-300">You: &ldquo;Pay ₦1000 MTN airtime to 08012345678 with AbaPay, from my wallet.&rdquo;</div>
            <div className="text-emerald-400">→ Agent reads the skill, picks the x402 path (no account needed)</div>
            <div className="text-slate-500 pl-4">✓ POST /api/pay/x402 → 402 Payment Required, price named</div>
            <div className="text-slate-500 pl-4">✓ Signs EIP-3009 transferWithAuthorization with your wallet&apos;s own key</div>
            <div className="text-slate-500 pl-4">✓ Retries with X-PAYMENT header → 200 SUCCESS, tx_hash returned</div>
            <div className="text-slate-300 mt-2">Agent: &ldquo;Paid — airtime is on its way. Tx: 0x91a3...4f2c&rdquo;</div>
          </div>
        </div>
      </section>

      <section className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-[2rem] p-6 sm:p-8 flex items-start gap-3">
        <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-emerald-800 dark:text-emerald-300 leading-relaxed">
          That&apos;s the whole install-to-payment loop. Full parameter reference for every tool: <Link href="/agents/tools" className="underline">Tools</Link>. Every way a call can fail: <Link href="/agents/errors" className="underline">Error codes</Link>. Want it in code instead of a skill: <Link href="/agents/sdk" className="underline">abapay-sdk</Link> <span className="inline-flex items-center gap-1"><Puzzle size={12} /></span>.
        </p>
      </section>
    </>
  );
}
