import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TOOLS } from "../toolSchemas";

export const metadata: Metadata = {
  title: "Tools Reference — AbaPay Rails",
  description: "Every function an agent can call on AbaPay, and exactly how to reach it on each rail — MCP, A2A, REST, and the SDK, in one table.",
};

interface Row {
  capability: string;
  mcpA2a: string | null;
  rest: string | null;
  sdk: string | null;
}

// ⚡ THIS IS THE ROSETTA STONE, NOT A DUPLICATE OF /agents/mcp — that page has the full
// per-tool parameter tables (name/type/required/description). This page answers a different
// question: "I know WHAT I want to do — which rail actually exposes it, and what do I call?"
// Blank cells are real, not omissions: the REST/SDK surfaces are deliberately narrower than
// the full MCP/A2A tool catalog (x402 is one endpoint by design; the SDK wraps the two most
// common paths, not all ten tools) — see each rail's own page for why.
const ROWS: Row[] = [
  { capability: "Check what's payable / paused", mcpA2a: "describe_capabilities", rest: null, sdk: null },
  { capability: "Check balance + agent limit", mcpA2a: "check_balance", rest: null, sdk: "agent.checkBalance()" },
  { capability: "List DATA/CABLE/EDUCATION plans", mcpA2a: "list_plans", rest: null, sdk: null },
  { capability: "List international top-up options", mcpA2a: "list_international_options", rest: null, sdk: null },
  { capability: "Transaction history", mcpA2a: "transaction_history", rest: null, sdk: "agent.transactionHistory()" },
  { capability: "Pay one bill", mcpA2a: "pay_bill", rest: "POST /api/pay/x402", sdk: "agent.payBill() · payBillViaX402()" },
  { capability: "Pay 2-20 recipients in one call", mcpA2a: "pay_bill_batch", rest: null, sdk: null },
  { capability: "Schedule a recurring/future bill", mcpA2a: "schedule_bill", rest: null, sdk: "agent.scheduleBill()" },
  { capability: "List active schedules", mcpA2a: "list_schedules", rest: null, sdk: null },
  { capability: "Cancel a schedule", mcpA2a: "cancel_schedule", rest: null, sdk: null },
  { capability: "Link a wallet, mint an api_key", mcpA2a: null, rest: "POST /api/agent/link", sdk: "AbaPayAgent.link()" },
];

export default function ToolsPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Reference</span>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mt-1 mb-4 text-balance">Tools reference</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          Every function an agent can call on AbaPay, and exactly which rail exposes it. {TOOLS.length} capabilities live on MCP and A2A identically (one execution engine, two protocols); REST and the SDK cover the most common paths, not the full catalog.
        </p>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800/60">
                <th className="py-2.5 pr-4 font-bold">Capability</th>
                <th className="py-2.5 pr-4 font-bold">MCP / A2A</th>
                <th className="py-2.5 pr-4 font-bold">REST</th>
                <th className="py-2.5 font-bold">SDK</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {ROWS.map((r) => (
                <tr key={r.capability}>
                  <td className="py-3 pr-4 font-bold text-slate-700 dark:text-slate-300">{r.capability}</td>
                  <td className="py-3 pr-4">
                    {r.mcpA2a ? (
                      <a href={`/agents/mcp#${r.mcpA2a}`} className="text-xs">
                        <code className="text-emerald-600 dark:text-emerald-400 font-bold hover:underline">{r.mcpA2a}</code>
                      </a>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-700">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {r.rest ? <code className="text-slate-600 dark:text-slate-400 text-xs">{r.rest}</code> : <span className="text-slate-300 dark:text-slate-700">—</span>}
                  </td>
                  <td className="py-3">
                    {r.sdk ? <code className="text-slate-600 dark:text-slate-400 text-xs">{r.sdk}</code> : <span className="text-slate-300 dark:text-slate-700">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid sm:grid-cols-3 gap-4">
        <Link href="/agents/mcp" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl p-5 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
          <div className="text-xs font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">Full parameters</div>
          <p className="text-sm text-slate-500 dark:text-slate-400">Every field, type, and requirement for all {TOOLS.length} tools, plus a live try-it panel →</p>
        </Link>
        <Link href="/agents/errors" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl p-5 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
          <div className="text-xs font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">Error codes</div>
          <p className="text-sm text-slate-500 dark:text-slate-400">Every real code these calls can fail with, and whether it&apos;s worth retrying →</p>
        </Link>
        <Link href="/agents/sdk" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl p-5 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
          <div className="text-xs font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">SDK</div>
          <p className="text-sm text-slate-500 dark:text-slate-400">Full function signatures for abapay-sdk →</p>
        </Link>
      </section>
    </>
  );
}
