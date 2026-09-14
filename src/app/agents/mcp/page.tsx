import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import CopyBlock from "../CopyBlock";

export const metadata: Metadata = {
  title: "MCP — AbaPay Tool Server",
  description: "AbaPay as a Model Context Protocol server — 10 tools over Streamable HTTP JSON-RPC, the same protocol Claude and any MCP client speak.",
};

const TOOLS: { name: string; desc: string }[] = [
  { name: "describe_capabilities", desc: "Human-readable menu of what AbaPay can pay and what's currently paused." },
  { name: "check_balance", desc: "The linked wallet's live balance and approved agent limit, per token, per chain." },
  { name: "list_plans", desc: "Real, currently purchasable DATA / CABLE / EDUCATION plans with exact variation codes." },
  { name: "list_international_options", desc: "Browses the international catalogue — country → product type → operator → priced plan." },
  { name: "transaction_history", desc: "Recent payments, paginated." },
  { name: "pay_bill", desc: "Pay one bill — airtime, data, electricity, cable, education, international." },
  { name: "pay_bill_batch", desc: "Up to 20 recipients under one PIN." },
  { name: "schedule_bill", desc: "Recurring or delayed payments." },
  { name: "list_schedules", desc: "What automations are currently set up." },
  { name: "cancel_schedule", desc: "Cancel one." },
];

export default function MCPPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Local + remote</span>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">MCP</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          10 tools over Streamable HTTP JSON-RPC — the same protocol Claude and any MCP client speak. OAuth 2.1 is supported and preferred; an Agent Hub API key remains the fallback for clients that can&apos;t do OAuth.
        </p>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">Connect</h2>
        <CopyBlock
          code={`{
  "mcpServers": {
    "abapay": { "url": "https://www.abapays.com/api/mcp" }
  }
}`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
          Claude Desktop / Code: Settings → Connectors → Add custom connector → paste the URL above.
        </p>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">The 10 tools</h2>
        <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
          {TOOLS.map((t) => (
            <div key={t.name} className="py-3 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
              <code className="text-sm font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0 sm:w-52">{t.name}</code>
              <p className="text-sm text-slate-500 dark:text-slate-400">{t.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">Same PIN rules as A2A</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
          MCP and A2A share one execution engine, one linking flow, and one PIN model — set entirely by API, never through a browser. See <Link href="/agents/a2a" className="underline hover:text-emerald-500">/agents/a2a</Link> for the exact request that does it.
        </p>
      </section>
    </>
  );
}
