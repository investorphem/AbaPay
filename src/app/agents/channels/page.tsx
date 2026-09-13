import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Send, MessageCircle, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "Channels — AbaPay on Telegram & WhatsApp",
  description: "AbaPay's own conversational agent identity, reachable in plain language on Telegram and WhatsApp — the same execution engine as every protocol channel.",
};

const CHANNELS = [
  {
    name: "Telegram",
    icon: Send,
    handle: "@AbaPays",
    href: "https://t.me/AbaPays",
  },
  {
    name: "WhatsApp",
    icon: MessageCircle,
    handle: "+234 707 541 8792",
    href: "https://wa.me/2347075418792",
  },
];

export default function ChannelsPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Conversational</span>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">Telegram &amp; WhatsApp</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          Before it was reachable by MCP, A2A, or x402, AbaPay was already an agent — a natural-language identity, not a protocol endpoint. Every payment it makes on these channels runs through the exact same allowance-bounded execution engine as every other rail on this site.
        </p>
      </div>

      <section className="grid sm:grid-cols-2 gap-4 mb-6">
        {CHANNELS.map((c) => (
          <a key={c.name} href={c.href} target="_blank" rel="noopener noreferrer" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
            <div className="bg-emerald-50 dark:bg-emerald-900/20 w-11 h-11 rounded-xl flex items-center justify-center mb-4 border border-emerald-100 dark:border-emerald-800/50">
              <c.icon className="text-emerald-500" size={20} />
            </div>
            <h3 className="font-black text-slate-900 dark:text-white mb-1 flex items-center gap-1.5">{c.name} <ExternalLink size={13} className="text-slate-300 dark:text-slate-600" /></h3>
            <p className="text-sm font-mono text-slate-500 dark:text-slate-400">{c.handle}</p>
          </a>
        ))}
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">What this is — and isn&apos;t</h2>
        <div className="space-y-4 text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
          <p>
            This is <strong className="text-slate-900 dark:text-white">AbaPay&apos;s own agent identity</strong> — the same one <Link href="/agents/about" className="underline hover:text-emerald-500">registered on-chain under ERC-8004</Link> — reachable in plain language. A human types &quot;pay 1000 naira MTN airtime to 08012345678&quot; and it understands intent, not menu numbers. Nothing here is a separate system: it&apos;s the identical execution pipeline behind <Link href="/agents/mcp" className="underline hover:text-emerald-500">MCP</Link> and <Link href="/agents/a2a" className="underline hover:text-emerald-500">A2A</Link>, just with a chat interface in front of it.
          </p>
          <p>
            The PIN here works the same way as everywhere else on this site — set inside the conversation itself (&quot;Reply with your PIN to set it up&quot;), never through a web form.
          </p>
          <p>
            What this <strong className="text-slate-900 dark:text-white">isn&apos;t</strong>: a structured, machine-typed protocol. A program that wants to drive these channels has to speak natural language the way a human would, rather than calling a typed function — which is exactly why <Link href="/agents/x402" className="underline hover:text-emerald-500">x402</Link>, <Link href="/agents/a2a" className="underline hover:text-emerald-500">A2A</Link> and <Link href="/agents/mcp" className="underline hover:text-emerald-500">MCP</Link> exist as separate, structured rails for agent-to-agent integration. Use this page to understand AbaPay as an agent in its own right; use those three to integrate one.
          </p>
        </div>
      </section>
    </>
  );
}
