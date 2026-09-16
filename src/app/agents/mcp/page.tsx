import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import CopyBlock from "../CopyBlock";
import ToolTable from "../ToolTable";
import MCPPlayground from "../MCPPlayground";
import { TOOLS } from "../toolSchemas";

export const metadata: Metadata = {
  title: "MCP — AbaPay Tool Server",
  description: "AbaPay as a Model Context Protocol server — 10 tools over Streamable HTTP JSON-RPC, full parameter reference, and a live try-it panel against production.",
};

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
          {TOOLS.length} tools over Streamable HTTP JSON-RPC — the same protocol Claude and any MCP client speak. OAuth 2.1 is supported and preferred; an Agent Hub API key remains the fallback for clients that can&apos;t do OAuth.
        </p>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">Connect</h2>
        <CopyBlock
          code={`{
  "mcpServers": {
    "abapay": { "url": "https://agents.abapays.com/api/mcp" }
  }
}`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
          Claude Desktop / Code: Settings → Connectors → Add custom connector → paste the URL above.
        </p>
      </section>

      <div className="mb-6">
        <MCPPlayground />
      </div>

      <h2 className="text-xl font-black tracking-tight text-slate-900 dark:text-white mb-4 px-2">
        The {TOOLS.length} tools — full reference
      </h2>
      <div className="mb-6">
        <ToolTable tools={TOOLS} />
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-3">Same PIN rules as A2A</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-2xl">
          MCP and A2A share one execution engine, one linking flow, and one PIN model — set entirely by API, never through a browser. See <Link href="/agents/a2a" className="underline hover:text-emerald-500">/agents/a2a</Link> for the exact request that does it, or <Link href="/agents/errors" className="underline hover:text-emerald-500">/agents/errors</Link> for what a failed call actually looks like.
        </p>
      </section>
    </>
  );
}
