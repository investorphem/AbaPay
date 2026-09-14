import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Fingerprint, Building2, Rocket, Workflow, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "About — AbaPay Rails",
  description: "Who operates AbaPay's Celo agent rails, its on-chain identity, and what's coming next.",
};

export default function AboutPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">About</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          AbaPay is non-custodial stablecoin settlement infrastructure for real-world bills — airtime, mobile data, electricity, cable, education — built by Masonode Technologies Limited. This site is its Celo-only, agent-first front door.
        </p>
      </div>

      <section className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6">
          <div className="bg-emerald-50 dark:bg-emerald-900/20 w-11 h-11 rounded-xl flex items-center justify-center mb-4 border border-emerald-100 dark:border-emerald-800/50">
            <Building2 className="text-emerald-500" size={20} />
          </div>
          <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Masonode Technologies Limited</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-3">
            The registered legal entity behind AbaPay — RC 9524980. Handles compliance, banking rails, and legal terms.
          </p>
          <a href="https://abapays.com/masonode" className="text-sm font-bold text-emerald-600 dark:text-emerald-400 hover:underline inline-flex items-center gap-1">Corporate page <ExternalLink size={12} /></a>
        </div>
        <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6">
          <div className="bg-emerald-50 dark:bg-emerald-900/20 w-11 h-11 rounded-xl flex items-center justify-center mb-4 border border-emerald-100 dark:border-emerald-800/50">
            <Fingerprint className="text-emerald-500" size={20} />
          </div>
          <h2 className="font-black text-slate-900 dark:text-white mb-1.5">On-chain identity</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-3">
            Registered on Celo under <a href="https://eips.ethereum.org/EIPS/eip-8004" target="_blank" rel="noopener noreferrer" className="underline">ERC-8004</a> — a verifiable agent identity other agents&apos; tooling can check independently, not just a claim on this page.
          </p>
          <a href="https://8004scan.io/agents/celo/9760" target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-emerald-600 dark:text-emerald-400 hover:underline inline-flex items-center gap-1">Verify on 8004scan <ExternalLink size={12} /></a>
        </div>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">Where to reach us</h2>
        <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5">
          <li>Support: <a href="mailto:support@abapays.com" className="underline hover:text-emerald-500">support@abapays.com</a></li>
          <li>Legal: <a href="/terms" className="underline hover:text-emerald-500">Terms</a> · <a href="/privacy" className="underline hover:text-emerald-500">Privacy</a></li>
          <li>Source: <a href="https://github.com/investorphem/AbaPay" className="underline hover:text-emerald-500">github.com/investorphem/AbaPay</a> (MIT)</li>
        </ul>
      </section>

      {/* ROADMAP — clearly labeled as not-yet-shipped */}
      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">Coming next</h2>
      <section className="bg-white dark:bg-[#111114] border border-dashed border-slate-200 dark:border-slate-700 rounded-[2rem] p-6 sm:p-8">
        <div className="grid sm:grid-cols-2 gap-6">
          <div>
            <div className="bg-slate-50 dark:bg-white/5 w-10 h-10 rounded-xl flex items-center justify-center mb-3 border border-slate-100 dark:border-slate-800/60">
              <Rocket className="text-slate-400" size={18} />
            </div>
            <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Python SDK</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              The <Link href="/agents/sdk" className="underline hover:text-emerald-500">TypeScript SDK</Link> ships today — a Python port is the natural next one, given how much agent tooling (LangChain, CrewAI, AutoGen) is Python-first. Not started yet — this is a proposal, not a claim.
            </p>
          </div>
          <div>
            <div className="bg-slate-50 dark:bg-white/5 w-10 h-10 rounded-xl flex items-center justify-center mb-3 border border-slate-100 dark:border-slate-800/60">
              <Workflow className="text-slate-400" size={18} />
            </div>
            <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Wider agent-registry discovery</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              Already listed in the official MCP Registry and on-chain via ERC-8004; a fuller OASF-style listing is the natural next registry to add for cross-framework discoverability.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
