import type { Metadata } from "next";
import Link from "next/link";
import {
  Zap, ShieldCheck, CalendarClock, Layers, Link2, Terminal,
  ExternalLink, CheckCircle2, MessageCircle, Rocket, Fingerprint,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getAgentStats } from "@/lib/dune/agentStats";

// ⚡ agents.abapays.com'S HOMEPAGE — see middleware.ts's AGENT_HOSTS rewrite for how this
// domain resolves here, and layout.tsx for the header/nav/footer shared across every page in
// this directory. This is now a real multi-page site (x402/, a2a/, mcp/, sdk/, channels/,
// about/ — each its own route, its own metadata, its own URL), not one long page with anchor
// links: clicking "A2A" in the header genuinely navigates to /agents/a2a, the same as clicking
// A2A on usecelina.xyz navigates to usecelina.xyz/a2a.
//
// CELO-ONLY, DELIBERATELY. AbaPay's contracts also run on Base, documented elsewhere
// (README.md, the main dashboards) — but this site's audience is Celo agent infrastructure
// specifically. Every number, address and endpoint across this whole /agents/* tree is Celo
// mainnet only.
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

// ⚡ THREE WAYS IN — genuinely different trust models, and conflating them is the single most
// common confusion a developer hits reading agent-payment docs. Said plainly, once, here, then
// each gets its own full page.
const PATHS = [
  {
    tag: "ZERO SETUP",
    title: "x402",
    forWhom: "An agent that already holds a Celo wallet and wants to pay, right now, with nothing set up in advance.",
    needs: ["No account", "No API key", "No PIN", "No visit to abapays.com — ever"],
    href: "/agents/x402",
  },
  {
    tag: "LINKED WALLET",
    title: "A2A / MCP",
    forWhom: "An agent that links a wallet once — one signed message, an on-chain spending allowance, not a deposit — for the fuller tool catalog.",
    needs: ["One signed message to link (no browser)", "A PIN it sets itself, via that same API call", "Full 10-tool catalog"],
    href: "/agents/a2a",
  },
  {
    tag: "CONVERSATIONAL",
    title: "Telegram / WhatsApp",
    forWhom: "AbaPay's own agent identity, reachable in plain language — by a human, or by anything capable of driving a chat client.",
    needs: ["No app install", "PIN set inside the chat itself", "Same execution engine as every other channel"],
    href: "/agents/channels",
  },
];

const STACK: { title: string; tag: string; body: string; icon: LucideIcon; href: string; verify?: { label: string; href: string } }[] = [
  {
    title: "x402",
    tag: "ZERO SETUP",
    icon: Zap,
    body: "Challenge/response payment over plain HTTP. No credential of any kind.",
    href: "/agents/x402",
    verify: { label: "Source", href: "https://github.com/investorphem/AbaPay/blob/main/src/app/api/pay/x402/route.ts" },
  },
  {
    title: "A2A",
    tag: "PEER PROTOCOL",
    icon: Link2,
    body: "Agent Card discovery + JSON-RPC task server for peer agents.",
    href: "/agents/a2a",
    verify: { label: "Agent Card", href: "/.well-known/agent-card.json" },
  },
  {
    title: "MCP",
    tag: "LOCAL + REMOTE",
    icon: Terminal,
    body: "Streamable HTTP JSON-RPC, OAuth 2.1 or API key. The same protocol Claude speaks.",
    href: "/agents/mcp",
    verify: { label: "Registry listing", href: "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.investorphem/abapay" },
  },
  {
    title: "API",
    tag: "PLAIN HTTP",
    icon: Layers,
    body: "OpenAPI 3.1 reference for the same settlement endpoint — no protocol wrapper required.",
    href: "/agents/api",
    verify: { label: "openapi.json", href: "/openapi.json" },
  },
  {
    title: "SDK",
    tag: "TYPESCRIPT",
    icon: Rocket,
    body: "abapay-sdk wraps x402 signing and the MCP catalog into two functions.",
    href: "/agents/sdk",
    verify: { label: "npm", href: "https://www.npmjs.com/package/abapay-sdk" },
  },
  {
    title: "Channels",
    tag: "CONVERSATIONAL",
    icon: MessageCircle,
    body: "Telegram and WhatsApp — AbaPay's own agent identity, reachable in natural language.",
    href: "/agents/channels",
  },
  {
    title: "Identity",
    tag: "ON-CHAIN",
    icon: Fingerprint,
    body: "ERC-8004 registration on Celo — a verifiable identity other agents' tooling can check.",
    href: "/agents/about",
    verify: { label: "8004scan", href: "https://8004scan.io/agents/celo/9760" },
  },
];

// ⚡ THE LIVE DEMO PANEL BELOW — every field name, address and network id is real, copied from
// src/app/api/pay/x402/route.ts's actual challenge construction. See /agents/x402 for the full
// walkthrough with the complete JSON.
const CELO_NETWORK = "eip155:42220";
const CELO_VAULT = "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C";

export default async function AgentsHomePage() {
  const stats = await getAgentStats();
  const HERO_STATS = [
    { v: `$${Math.round(stats.volumeUsd).toLocaleString()}`, l: "Total volume" },
    { v: `${stats.agentNativePct.toFixed(1)}%`, l: "Agent-native rail" },
    { v: stats.uniqueWallets.toLocaleString(), l: "Unique wallets" },
    { v: stats.transactions.toLocaleString(), l: "Transactions" },
  ];

  return (
    <>
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

      {/* THREE WAYS IN */}
      <section className="grid sm:grid-cols-3 gap-4 mb-6">
        {PATHS.map((p) => (
          <Link key={p.title} href={p.href} className="block bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
            <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">{p.tag}</span>
            <h3 className="text-lg font-black text-slate-900 dark:text-white mt-1 mb-2">{p.title}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-3">{p.forWhom}</p>
            <ul className="space-y-1">
              {p.needs.map((n) => (
                <li key={n} className="text-xs text-slate-500 dark:text-slate-500 flex items-start gap-2">
                  <CheckCircle2 size={12} className="text-emerald-500 flex-shrink-0 mt-0.5" /> {n}
                </li>
              ))}
            </ul>
          </Link>
        ))}
      </section>

      {/* LIVE NUMBERS — Celo mainnet only, read from Dune at request time. */}
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
      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">The rails</h2>
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

      {/* THE STACK — a real directory to real pages, not anchors */}
      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">The stack</h2>
      <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {STACK.map((s) => (
          <div key={s.title} className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.5rem] p-5 flex flex-col">
            <div className="bg-emerald-50 dark:bg-emerald-900/20 w-9 h-9 rounded-lg flex items-center justify-center mb-3 border border-emerald-100 dark:border-emerald-800/50">
              <s.icon className="text-emerald-500" size={16} />
            </div>
            <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">{s.tag}</span>
            <h3 className="font-black text-slate-900 dark:text-white mb-1.5">{s.title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4 flex-1">{s.body}</p>
            <div className="flex items-center gap-3 text-xs font-bold">
              <Link href={s.href} className="text-emerald-600 dark:text-emerald-400 hover:underline">Open →</Link>
              {s.verify && (
                <a href={s.verify.href} target="_blank" rel="noopener noreferrer" className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-1">
                  {s.verify.label} <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
