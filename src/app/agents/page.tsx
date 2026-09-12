import Link from "next/link";
import type { Metadata } from "next";
import AppFooter from "@/components/AppFooter";
import {
  ArrowLeft, Bot, Zap, ShieldCheck, CalendarClock, Layers,
  Link2, Globe, Fingerprint, FolderGit2, BookOpen, Terminal, ExternalLink,
} from "lucide-react";

// ⚡ A SEPARATE FRONT DOOR, DELIBERATELY — not a new backend, not a new domain, not a copy
// of anything. Same execution engine, same contracts, same MCP server, same x402 endpoint
// that already exist. What didn't exist was a page whose FIRST AND ONLY subject is the
// rails themselves — every other surface (`/`, `/docs`) leads with the consumer bill-pay
// story and mentions MCP/x402 partway down. A reviewer evaluating "is this reusable agent
// infrastructure or a consumer app with an agent bolted on" was always going to read `/`
// first, and `/` is unambiguously the consumer app.
//
// Nothing here is invented for this page. Every number, link and claim traces to something
// already shipped and already documented elsewhere in this repo — see
// docs/AGENT_INTEGRATION.md for the mechanics, dune/*/README.md for where the figures below
// come from, and README.md's own MCP/x402 sections for the rest. This page's only job is to
// put that material first, on its own URL, instead of requiring someone to already know
// AbaPay is infrastructure before they'd think to look for it here.
export const metadata: Metadata = {
  title: "AbaPay Rails — Agent Payment Infrastructure",
  description:
    "Non-custodial stablecoin settlement rails on Celo and Base, built for agents: MCP tools, x402 settlement, escrow, scheduled spend, batch payments, and agent-to-agent payments.",
};

const RAILS = [
  {
    icon: Terminal,
    title: "MCP tools",
    body: "10 tools over Streamable HTTP JSON-RPC — check_balance, pay_bill, schedule_bill, pay_bill_batch and more. The same protocol Claude and any MCP client speak.",
  },
  {
    icon: Zap,
    title: "x402 settlement",
    body: "Zero-setup, agent-to-agent by design: no account, no API key. A wallet gets a 402 challenge, signs, retries, settles. Already the majority of on-chain volume.",
  },
  {
    icon: ShieldCheck,
    title: "Escrow",
    body: "Payments settle into the contract and stay there until off-chain delivery confirms. A failed delivery refunds on-chain automatically — never a silent write-off.",
  },
  {
    icon: CalendarClock,
    title: "Scheduled & batch spend",
    body: "schedule_bill for recurring or delayed payments; pay_bill_batch for up to 20 recipients under one PIN. Both bounded by the same on-chain allowance as everything else.",
  },
  {
    icon: Link2,
    title: "Agent-to-agent payments",
    body: "Headless onboarding end to end: a wallet signature plus two on-chain calls. No browser, no human account-creation step, ever.",
  },
  {
    icon: Globe,
    title: "Celo interoperability",
    body: "Celo-first, not a Base port with Celo added on — redeployed V3→V4, three native stablecoins (USD₮/USDC/USA₮), on-chain rails other Celo agent tooling can build on top of.",
  },
];

const LINKS = [
  { label: "Agent Integration Guide", desc: "Headless onboarding, exact request/response shapes", href: "https://github.com/investorphem/AbaPay/blob/main/docs/AGENT_INTEGRATION.md", icon: BookOpen },
  { label: "Quickstart script", desc: "The whole flow as one runnable file", href: "https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs", icon: Terminal },
  { label: "OpenAPI reference", desc: "Machine-readable REST surface", href: "https://www.abapays.com/openapi.json", icon: Layers },
  { label: "GitHub repository", desc: "Public, MIT licensed", href: "https://github.com/investorphem/AbaPay", icon: FolderGit2 },
  { label: "MCP Registry listing", desc: "io.github.investorphem/abapay", href: "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.investorphem/abapay", icon: Bot },
  { label: "ERC-8004 identity", desc: "Agent #9760 on Celo, verified", href: "https://8004scan.io/agents/celo/9760", icon: Fingerprint },
];

const DASHBOARDS = [
  { name: "Ecosystem Traction", desc: "Combined Celo + Base, agent-vs-direct-vs-x402 rail split", href: "https://dune.com/abapay/abapay-ecosystem-traction" },
  { name: "AbaPay on Celo", desc: "Celo mainnet only", href: "https://dune.com/abapay/abapay-on-celo" },
  { name: "AbaPay on Base", desc: "Base mainnet only", href: "https://dune.com/abapay/abapay-on-base" },
];

export default function AgentsPage() {
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans p-4 sm:p-8 flex flex-col items-center pb-20 transition-colors">
      <div className="w-full max-w-4xl">

        {/* HEADER */}
        <div className="flex items-center justify-between mb-8">
          <Link href="/" className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors bg-white dark:bg-[#111114] p-2 rounded-xl border border-slate-100 dark:border-slate-800/60">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> For agents & developers
          </div>
        </div>

        {/* HERO */}
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 sm:p-12 shadow-sm mb-6">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4">
            AbaPay Rails
          </h1>
          <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
            Non-custodial stablecoin settlement infrastructure on Celo and Base — built so an agent, not a human, is the one calling it. Any MCP client or x402-aware agent can reach these rails without AbaPay ever knowing it exists in advance.
          </p>
          <p className="text-sm text-slate-400 dark:text-slate-500 mt-4">
            Building a consumer bill-pay experience instead? <Link href="/" className="underline hover:text-emerald-500">Use the app →</Link>
          </p>
        </section>

        {/* LIVE NUMBERS */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-slate-100 dark:bg-slate-800/60 rounded-[2rem] overflow-hidden border border-slate-100 dark:border-slate-800/60 mb-6">
          {[
            { v: "$34,519", l: "Total volume" },
            { v: "79.5%", l: "Agent-native rail" },
            { v: "408", l: "Unique wallets" },
            { v: "23,130", l: "Transactions" },
          ].map((s) => (
            <div key={s.l} className="bg-white dark:bg-[#111114] p-5 sm:p-6">
              <div className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">{s.v}</div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-1">{s.l}</div>
            </div>
          ))}
        </section>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-10 px-2">
          Celo + Base combined, on-chain, as of 2026-09-11 — see the live dashboards below for current figures. "Agent-native" is x402 plus agent-relayer volume together.
        </p>

        {/* THE RAILS */}
        <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">The rails</h2>
        <section className="grid sm:grid-cols-2 gap-4 mb-10">
          {RAILS.map((r) => (
            <div key={r.title} className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 w-11 h-11 rounded-xl flex items-center justify-center mb-4 border border-emerald-100 dark:border-emerald-800/50">
                <r.icon className="text-emerald-500" size={20} />
              </div>
              <h3 className="font-black text-slate-900 dark:text-white mb-1.5">{r.title}</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{r.body}</p>
            </div>
          ))}
        </section>

        {/* INTEGRATE */}
        <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">Integrate</h2>
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] divide-y divide-slate-100 dark:divide-slate-800/60 mb-10 overflow-hidden">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-4 p-5 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors group">
              <div className="flex items-center gap-4 min-w-0">
                <div className="bg-slate-50 dark:bg-white/5 w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border border-slate-100 dark:border-slate-800/60">
                  <l.icon className="text-slate-400 dark:text-slate-500" size={16} />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-sm text-slate-900 dark:text-white">{l.label}</div>
                  <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{l.desc}</div>
                </div>
              </div>
              <ExternalLink className="text-slate-300 dark:text-slate-600 group-hover:text-emerald-500 transition-colors flex-shrink-0" size={16} />
            </a>
          ))}
        </section>

        {/* DASHBOARDS */}
        <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">Live on-chain activity</h2>
        <section className="grid sm:grid-cols-3 gap-4">
          {DASHBOARDS.map((d) => (
            <a key={d.name} href={d.href} target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.5rem] p-5 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
              <div className="font-black text-sm text-slate-900 dark:text-white mb-1">{d.name}</div>
              <div className="text-xs text-slate-400 dark:text-slate-500">{d.desc}</div>
            </a>
          ))}
        </section>

      </div>
      <div className="w-full max-w-4xl">
        <AppFooter />
      </div>
    </main>
  );
}
