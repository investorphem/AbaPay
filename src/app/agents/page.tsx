import type { Metadata } from "next";
import AppFooter from "@/components/AppFooter";
import {
  ArrowLeft, Bot, Zap, ShieldCheck, CalendarClock, Layers,
  Link2, Globe, Fingerprint, FolderGit2, BookOpen, Terminal, ExternalLink,
  FileText, Building2, Mail, Send,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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

// ⚡ THE RESOURCE FOOTER — the point of this whole page is to be a standalone front door
// (see the file-level comment above and middleware.ts's agent-host rewrite). A front door
// that dead-ends without a proper directory of everything a developer or a company doing
// diligence would look for — source code, the registries that vouch for this identity,
// legal/contact — isn't standalone, it's just a hero banner. Every link below already exists
// elsewhere in this repo or its live deployment; nothing here is new surface area, only a
// single, categorized place a diligence pass can start from and reach all of it.
const FOOTER_GROUPS: { title: string; links: { label: string; href: string; icon: LucideIcon }[] }[] = [
  {
    title: "Developers",
    links: [
      { label: "Agent Integration Guide", href: "https://github.com/investorphem/AbaPay/blob/main/docs/AGENT_INTEGRATION.md", icon: BookOpen },
      { label: "Quickstart script", href: "https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs", icon: Terminal },
      { label: "OpenAPI reference", href: "https://abapays.com/openapi.json", icon: Layers },
      { label: "Docs & FAQ", href: "https://abapays.com/docs", icon: FileText },
    ],
  },
  {
    title: "Verify",
    links: [
      { label: "GitHub repository", href: "https://github.com/investorphem/AbaPay", icon: FolderGit2 },
      { label: "MCP Registry listing", href: "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.investorphem/abapay", icon: Bot },
      { label: "ERC-8004 identity", href: "https://8004scan.io/agents/celo/9760", icon: Fingerprint },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About Masonode Technologies", href: "https://abapays.com/masonode", icon: Building2 },
      { label: "Terms", href: "https://abapays.com/terms", icon: FileText },
      { label: "Privacy", href: "https://abapays.com/privacy", icon: ShieldCheck },
      { label: "Support", href: "mailto:support@abapays.com", icon: Mail },
    ],
  },
];

// Social/community — kept separate from FOOTER_GROUPS above because these are icon-only
// buttons (matching AppFooter's own X/Telegram treatment) rather than labeled directory rows.
// lucide-react ships no brand mark for X or LinkedIn in this version (same gap as the missing
// "Github" icon elsewhere in this file) — X reuses AppFooter's inline path; LinkedIn isn't
// listed here at all rather than guessing a URL for a page that may not exist.
const SOCIALS = [
  {
    label: "X",
    href: "https://x.com/AbaPays",
    node: (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
      </svg>
    ),
  },
  { label: "Telegram", href: "https://t.me/AbaPays", node: <Send size={16} className="ml-[-1px]" /> },
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
          {/* Absolute, not relative: on agents.abapays.com, a relative "/" is rewritten by
              middleware.ts right back to this same page — this needs to actually leave the
              agent host and land on the consumer app's real homepage. */}
          <a href="https://abapays.com/" className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors bg-white dark:bg-[#111114] p-2 rounded-xl border border-slate-100 dark:border-slate-800/60">
            <ArrowLeft size={18} />
          </a>
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
            Building a consumer bill-pay experience instead? <a href="https://abapays.com/" className="underline hover:text-emerald-500">Use the app →</a>
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
        <section className="grid sm:grid-cols-3 gap-4 mb-16">
          {DASHBOARDS.map((d) => (
            <a key={d.name} href={d.href} target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.5rem] p-5 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
              <div className="font-black text-sm text-slate-900 dark:text-white mb-1">{d.name}</div>
              <div className="text-xs text-slate-400 dark:text-slate-500">{d.desc}</div>
            </a>
          ))}
        </section>

        {/* ⚡ RESOURCE FOOTER — see FOOTER_GROUPS above for why this exists as its own thing
            rather than folding into AppFooter: everything a developer or a company's diligence
            pass needs, in one categorized directory, on the page that's now this domain's
            homepage. */}
        <footer className="border-t border-slate-200 dark:border-slate-800/60 pt-10">
          <div className="grid sm:grid-cols-3 gap-8 mb-10">
            {FOOTER_GROUPS.map((group) => (
              <div key={group.title}>
                <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3 px-1">{group.title}</h3>
                <ul className="space-y-0.5">
                  {group.links.map((l) => (
                    <li key={l.label}>
                      <a
                        href={l.href}
                        target={l.href.startsWith('mailto:') ? undefined : '_blank'}
                        rel={l.href.startsWith('mailto:') ? undefined : 'noopener noreferrer'}
                        className="flex items-center gap-2.5 py-2 px-1 rounded-lg text-sm text-slate-600 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors"
                      >
                        <l.icon size={14} className="flex-shrink-0 text-slate-400 dark:text-slate-600" />
                        <span className="truncate">{l.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-5 pt-6 border-t border-slate-100 dark:border-slate-800/60">
            <p className="text-[10px] font-medium text-slate-400 dark:text-slate-600 uppercase tracking-[0.15em] text-center sm:text-left">
              © 2026 Masonode Technologies Limited · RC 9524980
            </p>
            <div className="flex items-center gap-3">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111114] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-900 transition-colors"
                >
                  {s.node}
                </a>
              ))}
            </div>
          </div>
        </footer>

      </div>
      <div className="w-full max-w-4xl">
        <AppFooter />
      </div>
    </main>
  );
}
