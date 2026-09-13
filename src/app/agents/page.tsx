import type { Metadata } from "next";
import {
  Bot, Zap, ShieldCheck, CalendarClock, Layers, Link2, Fingerprint, FolderGit2,
  BookOpen, Terminal, ExternalLink, FileText, Building2, Mail, Send, Rocket,
  Network, KeyRound, Ban, CheckCircle2, Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getAgentStats } from "@/lib/dune/agentStats";

// ⚡ A SEPARATE FRONT DOOR, DELIBERATELY — not a new backend, not a new domain, not a copy of
// anything. Same execution engine, same contracts, same MCP server, same x402 endpoint that
// already exist — this is agents.abapays.com's actual homepage (see middleware.ts's
// AGENT_HOSTS rewrite), not a subpage of the consumer app.
//
// STANDALONE ON PURPOSE. Earlier drafts of this page kept a header back-arrow and a hero line
// pointing at abapays.com — reasonable for a page reachable at abapays.com/agents, wrong for a
// page that IS its own domain's homepage. A visitor here should never be made to feel like
// they wandered into a corner of the consumer app; the only route back to it lives in the
// footer, one small line, exactly where a stray visitor would look and nobody else would.
//
// CELO-ONLY, DELIBERATELY. AbaPay's contracts also run on Base, and that's real, documented
// elsewhere (README.md, the main dashboards) — but this page's audience is Celo agent
// infrastructure specifically, and a page trying to be both reads as neither. Every number,
// address and endpoint below is Celo mainnet only.
//
// EXTERNAL LINKS ARE VERIFICATION, NOT CONTENT. The previous version of this page was mostly
// a list of links to GitHub/registries/dashboards. The actual mechanics — the x402 challenge
// shape, the A2A skill list, the MCP connection snippet — now live ON this page, in the
// sections below; external links remain only for a developer to independently verify a claim
// (the source code, the on-chain identity, the live ledger), never as the only way to read it.
//
// Nothing here is invented. Every field name, address and network id traces to
// src/app/api/pay/x402/route.ts, src/app/.well-known/agent-card.json/route.ts, and
// public/openapi.json — see docs/AGENT_INTEGRATION.md for the fuller mechanics and
// dune/celo-chain/README.md for where the live figures come from.
export const metadata: Metadata = {
  title: "AbaPay Rails — Celo Agent Payment Infrastructure",
  description:
    "Non-custodial stablecoin settlement rails for agents on Celo mainnet: zero-setup x402 payments, agent-to-agent (A2A), MCP tools, escrow, and scheduled spend.",
};

const RAILS = [
  {
    icon: Zap,
    title: "x402 settlement",
    body: "Zero setup, agent-to-agent by design: no account, no API key, no PIN. A wallet gets a 402 challenge, signs, retries, settles. Already the majority of on-chain volume on Celo.",
  },
  {
    icon: Link2,
    title: "Agent-to-agent (A2A)",
    body: "A machine-readable Agent Card and a JSON-RPC endpoint any peer agent can call directly — no browser, no human in the loop.",
  },
  {
    icon: Terminal,
    title: "MCP tools",
    body: "10 tools over Streamable HTTP JSON-RPC — check_balance, pay_bill, schedule_bill, pay_bill_batch and more. The same protocol Claude and any MCP client speak.",
  },
  {
    icon: Layers,
    title: "REST API",
    body: "A plain OpenAPI 3.1 surface for any HTTP client that isn't MCP or A2A — same rails, same settlement, no protocol required.",
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
];

// ⚡ THE TWO WAYS IN — genuinely different trust models, and conflating them is the single
// most common confusion a developer hits reading agent-payment docs. Said plainly, once, here.
const PATHS = [
  {
    tag: "ZERO SETUP",
    title: "x402",
    forWhom: "An agent that already holds a Celo wallet and wants to pay, right now, with nothing set up in advance.",
    needs: ["No account", "No API key", "No PIN", "No visit to abapays.com"],
    anchor: "#x402",
  },
  {
    tag: "LINKED WALLET",
    title: "MCP / A2A",
    forWhom: "An agent that links a wallet once (an on-chain spending allowance, not a deposit) and wants the fuller tool catalog — history, schedules, batch payments.",
    needs: ["One-time wallet-signature link", "PIN on every payment call", "Full 10-tool catalog"],
    anchor: "#a2a",
  },
];

// The Agent Card's real skill list — see src/app/.well-known/agent-card.json/route.ts, the
// actual served document. Kept as data here so it can never drift from that file's SKILLS
// array without someone noticing the diff.
const A2A_SKILLS = [
  "describe_capabilities", "check_balance", "list_plans", "list_international_options",
  "transaction_history", "pay_bill", "pay_bill_batch", "schedule_bill",
  "list_schedules", "cancel_schedule",
];

const STACK: { title: string; tag: string; body: string; primary: { label: string; href: string }; verify?: { label: string; href: string } }[] = [
  {
    title: "x402",
    tag: "ZERO SETUP",
    body: "Challenge/response payment over plain HTTP. No credential of any kind.",
    primary: { label: "How it works", href: "#x402" },
    verify: { label: "Source", href: "https://github.com/investorphem/AbaPay/blob/main/src/app/api/pay/x402/route.ts" },
  },
  {
    title: "A2A",
    tag: "PEER PROTOCOL",
    body: "Agent Card discovery + JSON-RPC task server for peer agents.",
    primary: { label: "Skills & endpoint", href: "#a2a" },
    verify: { label: "Agent Card", href: "https://abapays.com/.well-known/agent-card.json" },
  },
  {
    title: "MCP",
    tag: "LOCAL + REMOTE",
    body: "Streamable HTTP JSON-RPC, OAuth 2.1 or API key. The same protocol Claude speaks.",
    primary: { label: "Connect", href: "#mcp" },
    verify: { label: "Registry listing", href: "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.investorphem/abapay" },
  },
  {
    title: "REST API",
    tag: "PLAIN HTTP",
    body: "OpenAPI 3.1, snake_case fields, no protocol wrapper required.",
    primary: { label: "OpenAPI spec", href: "https://abapays.com/openapi.json" },
  },
  {
    title: "SDK",
    tag: "TYPESCRIPT",
    body: "abapay-sdk wraps x402 signing and the MCP tool catalog into two functions. Source and tests are on GitHub now; the npm package follows shortly.",
    primary: { label: "Install & usage", href: "#sdk" },
    verify: { label: "Source", href: "https://github.com/investorphem/AbaPay/tree/main/sdk" },
  },
  {
    title: "Identity",
    tag: "ON-CHAIN",
    body: "ERC-8004 registration on Celo — a verifiable identity other agents' tooling can check.",
    primary: { label: "About", href: "#stack" },
    verify: { label: "8004scan", href: "https://8004scan.io/agents/celo/9760" },
  },
];

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
      { label: "Agent Card", href: "https://abapays.com/.well-known/agent-card.json", icon: Network },
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
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/masonode/",
    node: (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124zM7.114 20.452H3.558V9h3.556v11.452z"></path>
      </svg>
    ),
  },
];

// ⚡ THE x402 REQUEST/RESPONSE BELOW — every field name, address and network id is real,
// copied from src/app/api/pay/x402/route.ts's actual challenge construction (`acceptEntry`,
// the v1/v2 challenge bodies) and public/openapi.json's Celo `x-payment-info.protocols`
// entries. The dollar amount and tx hash are illustrative (a real amount is computed
// server-side from the live NGN rate at request time — see the route's own comment on why);
// everything else — scheme, network, asset addresses, payTo, the settle flow — is exactly
// what a real call gets back.
const CELO_NETWORK = "eip155:42220";
const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const CELO_VAULT = "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C";

function Nav() {
  const links = [
    { label: "Stack", href: "#stack" },
    { label: "x402", href: "#x402" },
    { label: "A2A", href: "#a2a" },
    { label: "MCP", href: "#mcp" },
    { label: "SDK", href: "#sdk" },
    { label: "Roadmap", href: "#roadmap" },
  ];
  return (
    <nav className="hidden sm:flex items-center gap-6">
      {links.map((l) => (
        <a key={l.label} href={l.href} className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors">
          {l.label}
        </a>
      ))}
    </nav>
  );
}

function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2 scroll-mt-24">
      {children}
    </h2>
  );
}

export default async function AgentsPage() {
  const stats = await getAgentStats();
  const HERO_STATS = [
    { v: `$${Math.round(stats.volumeUsd).toLocaleString()}`, l: "Total volume" },
    { v: `${stats.agentNativePct.toFixed(1)}%`, l: "Agent-native rail" },
    { v: stats.uniqueWallets.toLocaleString(), l: "Unique wallets" },
    { v: stats.transactions.toLocaleString(), l: "Transactions" },
  ];

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans transition-colors">
      <div className="max-w-4xl mx-auto p-4 sm:p-8 pb-20">

        {/* HEADER — wordmark + in-page nav, no tie back to the consumer app. See file-level
            comment: the one link back to abapays.com lives in the footer, not here. */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2 font-black tracking-tight text-lg text-slate-900 dark:text-white">
            AbaPay <span className="text-emerald-500">Rails</span>
          </div>
          <Nav />
          <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 px-2.5 py-1 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Celo mainnet
          </div>
        </div>

        {/* HERO */}
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 sm:p-12 shadow-sm mb-6 grid lg:grid-cols-2 gap-8 items-center">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">
              Give your agent a bill to pay.
            </h1>
            <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              Non-custodial stablecoin settlement on Celo, built agent-first: x402 for zero-setup payments, A2A and MCP for the fuller tool catalog. Any Celo wallet can pay a real-world bill without AbaPay ever knowing it exists in advance.
            </p>
          </div>

          {/* THE LIVE DEMO PANEL — a real request/response shape, not a mockup of an
              imaginary API. See the CELO_NETWORK/CELO_USDC/CELO_VAULT constants above for
              where every value comes from. */}
          <div className="bg-[#0b0d0f] rounded-[1.75rem] border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800 bg-white/[0.02]">
              <span className="text-slate-400 tracking-wider">x402 · agent-to-agent</span>
              <span className="flex items-center gap-1.5 text-emerald-400 font-bold text-[10px] uppercase tracking-widest">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live rail
              </span>
            </div>
            <div className="p-4 space-y-3 overflow-x-auto">
              <div>
                <span className="text-slate-500">$</span> <span className="text-slate-200">POST /api/pay/x402</span>
              </div>
              <div className="pl-3 border-l-2 border-red-500/40 text-slate-400">
                <span className="text-red-400 font-bold">402</span> Payment Required
                <div className="text-slate-500 mt-1">
                  accepts: [&#123; network: &quot;{CELO_NETWORK}&quot;, asset: &quot;USDT&quot;, payTo: &quot;{CELO_VAULT.slice(0, 8)}…&quot; &#125;]
                </div>
              </div>
              <div>
                <span className="text-slate-500">$</span> <span className="text-slate-200">sign transferWithAuthorization(...)</span> <span className="text-slate-600">— agent&apos;s own wallet</span>
              </div>
              <div>
                <span className="text-slate-500">$</span> <span className="text-slate-200">POST /api/pay/x402</span> <span className="text-slate-600">-H X-PAYMENT: &lt;signed&gt;</span>
              </div>
              <div className="pl-3 border-l-2 border-emerald-500/40 text-slate-400">
                <span className="text-emerald-400 font-bold">200</span> OK
                <div className="text-slate-500 mt-1">settled on Celo · bill vended</div>
              </div>
            </div>
          </div>
        </section>

        {/* THE TWO WAYS IN */}
        <section className="grid sm:grid-cols-2 gap-4 mb-6">
          {PATHS.map((p) => (
            <a key={p.title} href={p.anchor} className="block bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
              <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">{p.tag}</span>
              <h3 className="text-xl font-black text-slate-900 dark:text-white mt-1 mb-2">{p.title}</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-3">{p.forWhom}</p>
              <ul className="space-y-1">
                {p.needs.map((n) => (
                  <li key={n} className="text-xs text-slate-500 dark:text-slate-500 flex items-center gap-2">
                    <CheckCircle2 size={12} className="text-emerald-500 flex-shrink-0" /> {n}
                  </li>
                ))}
              </ul>
            </a>
          ))}
        </section>

        {/* LIVE NUMBERS — Celo mainnet only, read from Dune at request time. See
            src/lib/dune/agentStats.ts for how this stays current and what it falls back to. */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-slate-100 dark:bg-slate-800/60 rounded-[2rem] overflow-hidden border border-slate-100 dark:border-slate-800/60 mb-6">
          {HERO_STATS.map((s) => (
            <div key={s.l} className="bg-white dark:bg-[#111114] p-5 sm:p-6">
              <div className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">{s.v}</div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-1">{s.l}</div>
            </div>
          ))}
        </section>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-10 px-2">
          Celo mainnet only, refreshed daily. &quot;Agent-native&quot; is x402 plus agent-relayer volume, as a share of total volume. <a href="https://dune.com/abapay/abapay-on-celo" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-500">Verify on Dune →</a>
        </p>

        {/* THE RAILS */}
        <SectionLabel>The rails</SectionLabel>
        <section className="grid sm:grid-cols-2 gap-4 mb-14">
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

        {/* x402 — THE FLAGSHIP FLOW */}
        <SectionLabel id="x402">Zero-setup agent-to-agent · x402</SectionLabel>
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6 max-w-2xl">
            An independent agent — say, a Cowrie-style FX agent holding a Celo wallet — never needs to know AbaPay exists in advance. The whole exchange happens over plain HTTP, challenge and response:
          </p>
          <ol className="space-y-3 mb-6">
            {[
              "Holds or uses a Celo wallet.",
              "Calls AbaPay's quote / pay_bill endpoint directly.",
              "Gets 402 Payment Required back, with the exact price and asset.",
              "Signs an EIP-3009 transferWithAuthorization with that same wallet — nothing else.",
              "Retries the request with the signed authorization attached.",
              "AbaPay settles on Celo via Celo's own x402 facilitator and vends the bill.",
            ].map((step, i) => (
              <li key={step} className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
                <span className="w-5 h-5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-[10px] font-black flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                {step}
              </li>
            ))}
          </ol>

          <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 rounded-2xl p-5 mb-6">
            <p className="text-xs font-black uppercase tracking-widest text-red-500 dark:text-red-400 mb-2 flex items-center gap-1.5"><Ban size={13} /> Never required for this path</p>
            <div className="flex flex-wrap gap-2">
              {["abapays.com account", "Agent Hub", "API key", "PIN", "Wallet-signature link"].map((x) => (
                <span key={x} className="text-xs font-medium text-slate-600 dark:text-slate-400 bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 rounded-full px-3 py-1">{x}</span>
              ))}
            </div>
          </div>

          <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] leading-relaxed">
            <div className="px-4 py-2.5 border-b border-slate-800 bg-white/[0.02] text-slate-400">POST /api/pay/x402 → 402 response (real field names)</div>
            <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "${CELO_NETWORK}",
    "asset": "${CELO_USDT}",
    "payTo": "${CELO_VAULT}",
    "maxTimeoutSeconds": 86400,
    "extra": { "name": "Tether USD", "primaryType": "TransferWithAuthorization" }
  }]
}`}</pre>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
            Both USDC (<code className="text-slate-500">{CELO_USDC.slice(0, 10)}…</code>) and USD₮ settle via Celo&apos;s own x402 facilitator — each implements EIP-3009. Full field reference: <a href="https://abapays.com/openapi.json" className="underline hover:text-emerald-500">openapi.json</a>.
          </p>
        </section>

        {/* A2A */}
        <SectionLabel id="a2a">Agents talking to agents · A2A</SectionLabel>
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6 max-w-2xl">
            A peer agent discovers AbaPay via its Agent Card, then sends structured tool calls over A2A JSON-RPC — no browser, no human account-creation step.
          </p>
          <div className="grid sm:grid-cols-2 gap-4 mb-6">
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-100 dark:border-slate-800/60">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Agent Card</div>
              <a href="https://abapays.com/.well-known/agent-card.json" className="text-xs font-mono text-emerald-600 dark:text-emerald-400 hover:underline break-all">abapays.com/.well-known/agent-card.json</a>
            </div>
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-100 dark:border-slate-800/60">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">JSON-RPC endpoint</div>
              <span className="text-xs font-mono text-slate-600 dark:text-slate-400 break-all">abapays.com/api/a2a</span>
            </div>
          </div>
          <div className="mb-6">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">Skills (10)</div>
            <div className="flex flex-wrap gap-2">
              {A2A_SKILLS.map((s) => (
                <code key={s} className="text-xs bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-slate-800/60 text-slate-600 dark:text-slate-400 rounded-lg px-2.5 py-1">{s}</code>
              ))}
            </div>
          </div>
          <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-xl p-4 flex items-start gap-2.5">
            <KeyRound size={15} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
              Unlike x402 above, A2A payment skills require an authenticated bearer (OAuth 2.1 token or an Agent Hub API key) plus the wallet PIN on every single payment call — a deliberate extra check for a linked-account path with the fuller tool catalog behind it.
            </p>
          </div>
        </section>

        {/* MCP */}
        <SectionLabel id="mcp">MCP — the same protocol Claude speaks</SectionLabel>
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-14">
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-5 max-w-2xl">
            10 tools over Streamable HTTP JSON-RPC — check_balance, pay_bill, schedule_bill, pay_bill_batch and more. OAuth 2.1 is supported and preferred; an Agent Hub API key remains the fallback for clients that can&apos;t do OAuth.
          </p>
          <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px]">
            <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`{
  "mcpServers": {
    "abapay": { "url": "https://www.abapays.com/api/mcp" }
  }
}`}</pre>
          </div>
        </section>

        {/* SDK */}
        <SectionLabel id="sdk">abapay-sdk — two functions, not a protocol to learn</SectionLabel>
        <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-14">
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-5 max-w-2xl">
            A thin TypeScript client over the two paths above — <code className="text-slate-500">payBillViaX402</code> for the zero-setup flow, <code className="text-slate-500">AbaPayAgent</code> for the linked-wallet catalog. Signs with whatever <a href="https://viem.sh" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-500">viem</a> account your agent already has; nothing hidden — the source is the same wire format documented above.
          </p>
          <div className="bg-[#0b0d0f] rounded-2xl border border-slate-800 overflow-hidden font-mono text-[11px] mb-4">
            <pre className="p-4 text-slate-300 overflow-x-auto whitespace-pre">{`import { privateKeyToAccount } from "viem/accounts";
import { payBillViaX402 } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const result = await payBillViaX402({
  signer: account,
  bill: {
    serviceID: "mtn", serviceCategory: "AIRTIME",
    network: "MTN", billersCode: "08012345678",
    nairaAmount: 1000, token: "USDT",
  },
});`}</pre>
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Source, tests, and the full README: <a href="https://github.com/investorphem/AbaPay/tree/main/sdk" className="underline hover:text-emerald-500">github.com/investorphem/AbaPay/tree/main/sdk</a>. The <code className="text-slate-500">abapay-sdk</code> npm package is next — until it&apos;s live, clone the repo and import directly from <code className="text-slate-500">sdk/src</code>.
          </p>
        </section>

        {/* STACK */}
        <SectionLabel id="stack">The stack</SectionLabel>
        <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-14">
          {STACK.map((s) => (
            <div key={s.title} className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.5rem] p-5 flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-2">{s.tag}</span>
              <h3 className="font-black text-slate-900 dark:text-white mb-1.5">{s.title}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4 flex-1">{s.body}</p>
              <div className="flex items-center gap-3 text-xs font-bold">
                <a href={s.primary.href} className="text-emerald-600 dark:text-emerald-400 hover:underline">{s.primary.label} →</a>
                {s.verify && (
                  <a href={s.verify.href} target="_blank" rel="noopener noreferrer" className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-1">
                    {s.verify.label} <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          ))}
        </section>

        {/* ROADMAP — clearly labeled as not-yet-shipped, never blended in with the sections above */}
        <SectionLabel id="roadmap">Coming next</SectionLabel>
        <section className="bg-white dark:bg-[#111114] border border-dashed border-slate-200 dark:border-slate-700 rounded-[2rem] p-6 sm:p-8 mb-14">
          <div className="grid sm:grid-cols-2 gap-6">
            <div>
              <div className="bg-slate-50 dark:bg-white/5 w-10 h-10 rounded-xl flex items-center justify-center mb-3 border border-slate-100 dark:border-slate-800/60">
                <Rocket className="text-slate-400" size={18} />
              </div>
              <h3 className="font-black text-slate-900 dark:text-white mb-1.5">Python SDK</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                The TypeScript SDK ships today (see above) — a Python port is the natural next one, given how much agent tooling (LangChain, CrewAI, AutoGen) is Python-first. Not started yet — this is a proposal, not a claim.
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

        {/* ⚡ SINGLE FOOTER — this page previously rendered its own resource footer AND the
            shared AppFooter beneath it, which duplicated Docs/Terms/Privacy and the social
            row. One footer now; the shared consumer-app AppFooter component is not used on
            this page at all, by design — this page owns its own, standalone. */}
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

          {/* The one deliberate, de-emphasized link back — see file-level comment. */}
          <p className="text-center text-xs text-slate-400 dark:text-slate-600 mt-8">
            Building a consumer bill-pay experience instead? <a href="https://abapays.com/" className="underline hover:text-emerald-500">abapays.com</a>
          </p>
        </footer>

      </div>
    </main>
  );
}
