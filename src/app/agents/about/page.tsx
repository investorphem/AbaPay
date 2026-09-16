import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Fingerprint, Building2, Rocket, Workflow, ExternalLink, CheckCircle2, Clock, Compass } from "lucide-react";
import { getDiscoveryStats } from "@/lib/discoveryStats";

export const metadata: Metadata = {
  title: "About — AbaPay Rails",
  description: "What's actually missing in agent-payment infrastructure today, why AbaPay exists to close that gap, who operates it, and where its agent is actually discoverable.",
};

const nf = new Intl.NumberFormat("en-US");

export default async function AboutPage() {
  const stats = await getDiscoveryStats();
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

      {/* ⚡ THE GAP — this is the section the previous version of this page didn't have: not
          "what AbaPay does" (every other page covers that) but "what's actually missing
          industry-wide, and why that's the reason this exists," stated plainly rather than
          left implicit. */}
      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">What&apos;s actually missing in agent payments</h2>
        <div className="space-y-4 text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
          <p>
            Agent-payment infrastructure has converged on three shapes, and each stops short of the same thing: an agent that can settle a payment but can&apos;t <strong className="text-slate-900 dark:text-white">complete an outcome</strong>.
          </p>
          <ul className="space-y-2.5">
            <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Crypto-native rails that stop at settlement.</strong> x402, A2A, and similar protocols move a stablecoin from one wallet to another correctly — and then the transaction is the whole story. Nothing on the other end turns that transfer into a phone with airtime on it, or a meter that isn&apos;t about to cut power.</li>
            <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Real-world commerce APIs built for a human in the loop.</strong> Card-based checkout, KYC gates, session cookies, a card-entry form — every one of these assumes a person is present to click through it. An autonomous agent, running unattended at 3am, cannot.</li>
            <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Custody as the price of automation.</strong> The systems that do let an agent transact repeatedly and unattended mostly do it by holding the user&apos;s funds or a stored payment credential on their behalf — trading away non-custodial guarantees for convenience, rather than keeping both.</li>
          </ul>
          <p>
            AbaPay is built at the seam those three leave open: a real x402, MCP, or A2A payment that actually completes — airtime credited, a bill paid, a real result — with the wallet still governed by an on-chain allowance the owner set and can revoke themselves, never a deposit or a stored card. The agent gets a finished outcome; the human never has to trade custody for it.
          </p>
        </div>
      </section>

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

      {/* ⚡ DISCOVERY — every real place an agent (or a person) can actually find this MCP
          server, not a claims list. Counts are live-fetched (src/lib/discoveryStats.ts) from
          npm's and GitHub's own public APIs, same "real number or null, never a guess" pattern
          getAgentStats() uses for the Dune-sourced numbers elsewhere on this site. A null count
          renders as "—", not a fabricated placeholder. */}
      <section id="discovery" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6 scroll-mt-24">
        <h2 className="font-black text-slate-900 dark:text-white mb-1.5 flex items-center gap-2"><Compass size={18} className="text-emerald-500" /> Where this agent is discoverable</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-4 max-w-2xl">
          Every real listing, not a claims list — click through and verify any of these yourself.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2 pr-4 font-bold">Surface</th>
                <th className="py-2 pr-4 font-bold">Listing</th>
                <th className="py-2 font-bold">Live count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">MCP Registry</td>
                <td className="py-2.5 pr-4"><a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">io.github.investorphem/abapay</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">—</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">Glama — server</td>
                <td className="py-2.5 pr-4"><a href="https://glama.ai/mcp/servers/investorphem/AbaPay" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">glama.ai/mcp/servers/investorphem/AbaPay</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">Approved</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">Glama — connector</td>
                <td className="py-2.5 pr-4"><a href="https://glama.ai/mcp/connectors" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">glama.ai/mcp/connectors</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">Listed</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">awesome-mcp-servers</td>
                <td className="py-2.5 pr-4"><a href="https://github.com/punkpeye/awesome-mcp-servers/pull/14459" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">PR #14459</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">Open</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">npm</td>
                <td className="py-2.5 pr-4"><a href="https://www.npmjs.com/package/abapay-sdk" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">abapay-sdk</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">{stats.npmDownloadsLastMonth !== null ? `${nf.format(stats.npmDownloadsLastMonth)} / mo` : "—"}</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">PyPI</td>
                <td className="py-2.5 pr-4"><a href="https://pypi.org/project/abapay-sdk/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">abapay-sdk</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">New</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">GitHub</td>
                <td className="py-2.5 pr-4"><a href="https://github.com/investorphem/AbaPay" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">investorphem/AbaPay</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">{stats.githubStars !== null ? `${nf.format(stats.githubStars)}★ ${nf.format(stats.githubForks ?? 0)} forks` : "—"}</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-bold text-slate-700 dark:text-slate-300">ERC-8004</td>
                <td className="py-2.5 pr-4"><a href="https://8004scan.io/agents/celo/9760" target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline">8004scan.io/agents/celo/9760</a></td>
                <td className="py-2.5 text-slate-400 dark:text-slate-500">Verified</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
          npm and GitHub counts are fetched live from their own public APIs — new package, small numbers, on purpose not padded.
        </p>
      </section>

      {/* ⚡ STATUS, NOT A WISHLIST — the previous version of this section was titled "Coming
          next" and both items said "not started yet." Both have real, verifiable work behind
          them now; this says exactly how far, not further. */}
      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">Status</h2>
      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <div className="grid sm:grid-cols-2 gap-6">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 w-10 h-10 rounded-xl flex items-center justify-center border border-emerald-100 dark:border-emerald-800/50">
                <Rocket className="text-emerald-500" size={18} />
              </div>
              <span className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={12} /> Shipped
              </span>
            </div>
            <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Python SDK</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              <code className="text-slate-500">python-sdk/</code> mirrors the <Link href="/agents/sdk" className="underline hover:text-emerald-500">TypeScript SDK</Link> field-for-field — same two functions, a real CLI, tests that recover the signer&apos;s address from the signed EIP-712 data and assert it matches. Live on PyPI: <code className="text-slate-500">pip install abapay-sdk</code>, published via a Trusted Publisher (no token secret) off a <code className="text-slate-500">py-sdk-v*</code> tag.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="bg-amber-50 dark:bg-amber-900/20 w-10 h-10 rounded-xl flex items-center justify-center border border-amber-100 dark:border-amber-800/50">
                <Workflow className="text-amber-600 dark:text-amber-400" size={18} />
              </div>
              <span className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">
                <Clock size={12} /> In review
              </span>
            </div>
            <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Wider agent-registry discovery</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              Listed on the official MCP Registry, on-chain via ERC-8004, and now approved on <a href="https://glama.ai/mcp/servers/investorphem/AbaPay" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-500">Glama&apos;s server directory</a> and its <a href="https://glama.ai/mcp/connectors" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-500">connector directory</a>. One PR still open against <code className="text-slate-500">awesome-mcp-servers</code> (95k+ stars) — ready to merge, waiting on that repo&apos;s own maintainer. Full list: <a href="#discovery" className="underline hover:text-emerald-500">above</a>.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
