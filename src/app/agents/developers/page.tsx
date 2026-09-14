import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, BookOpen, Terminal, FolderGit2, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "Developers — AbaPay Rails",
  description: "Integration guide, quickstart script, and the full reference map — read here, verify on GitHub.",
};

// ⚡ REFERENCE TABLE — straight from docs/AGENT_INTEGRATION.md's own "Reference" section, kept
// as data so it can't silently drift from that file. Each row's GitHub icon is the "view
// source" affordance the reading experience itself doesn't need — the row's own text already
// says what the file does; the icon is only for someone who wants the actual code.
const REFERENCE = [
  { what: "MCP transport", where: "src/app/api/mcp/route.ts" },
  { what: "MCP tool definitions & handlers", where: "src/lib/deai/mcpTools.ts" },
  { what: "Headless wallet-signature auth", where: "src/utils/walletAuth.ts" },
  { what: "Agent linking / API key minting", where: "src/app/api/agent/link/route.ts" },
  { what: "x402 resource server", where: "src/app/api/pay/x402/route.ts" },
  { what: "Settlement contract (current)", where: "contracts/AbaPayV4.sol" },
  { what: "OpenAPI reference", where: "public/openapi.json" },
];

const GITHUB_BASE = "https://github.com/investorphem/AbaPay/blob/main/";

export default function DevelopersPage() {
  return (
    <>
      <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Rails
      </Link>

      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">Developers</h1>
        <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
          Everything a developer needs, read here first — the GitHub icon on any item is for verifying the real source, never the only way to read it.
        </p>
      </div>

      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Link href="/agents/developers/guide" className="block bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
          <div className="bg-emerald-50 dark:bg-emerald-900/20 w-11 h-11 rounded-xl flex items-center justify-center mb-4 border border-emerald-100 dark:border-emerald-800/50">
            <BookOpen className="text-emerald-500" size={20} />
          </div>
          <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Integration guide</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">Non-custodial mechanics, the off-chain vend/refund handoff, and every kill switch that can stop an agent&apos;s spending.</p>
        </Link>
        <Link href="/agents/developers/quickstart" className="block bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[1.75rem] p-6 hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-colors">
          <div className="bg-emerald-50 dark:bg-emerald-900/20 w-11 h-11 rounded-xl flex items-center justify-center mb-4 border border-emerald-100 dark:border-emerald-800/50">
            <Terminal className="text-emerald-500" size={20} />
          </div>
          <h2 className="font-black text-slate-900 dark:text-white mb-1.5">Quickstart script</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">One runnable file, verified live against production — mints an API key, sets an allowance, checks a balance.</p>
        </Link>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-4">Reference map</h2>
        <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
          {REFERENCE.map((r) => (
            <div key={r.where} className="py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{r.what}</p>
                <code className="text-xs text-slate-400 dark:text-slate-500 truncate block">{r.where}</code>
              </div>
              <a href={`${GITHUB_BASE}${r.where}`} target="_blank" rel="noopener noreferrer" title="View on GitHub" className="p-2 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
                <FolderGit2 size={16} />
              </a>
            </div>
          ))}
        </div>
        <a href="https://github.com/investorphem/AbaPay" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-600 dark:text-emerald-400 hover:underline mt-5">
          Full repository <ExternalLink size={13} />
        </a>
      </section>
    </>
  );
}
