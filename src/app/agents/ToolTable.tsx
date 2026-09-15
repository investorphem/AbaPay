import type { ToolDef } from "./toolSchemas";
import { ACCESS_LABEL } from "./toolSchemas";

const ACCESS_STYLE: Record<ToolDef["access"], string> = {
  read: "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-800/50",
  write: "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-800/50",
  destructive: "bg-red-50 dark:bg-red-900/10 text-red-500 dark:text-red-400 border-red-100 dark:border-red-900/30",
};

// ⚡ EVERY FIELD FROM THE REAL SCHEMA, ROW-BY-ROW — the previous version of this page listed
// tool name + one description line, flat. This is the same data src/lib/deai/mcpTools.ts's
// real inputSchema carries per tool, rendered the way a REST/RPC reference actually should be:
// one row per parameter, its type, whether it's required, and what it does — so an integrating
// agent can build a real request without guessing a shape from prose.
export default function ToolTable({ tools }: { tools: ToolDef[] }) {
  return (
    <div className="space-y-4">
      {tools.map((t) => (
        <div key={t.name} id={t.name} className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl overflow-hidden scroll-mt-24">
          <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-slate-50 dark:border-slate-900">
            <div>
              <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                <code className="text-sm font-black text-slate-900 dark:text-white">{t.name}</code>
                <span className={`text-[9px] font-black uppercase tracking-widest border rounded-full px-2 py-0.5 ${ACCESS_STYLE[t.access]}`}>
                  {ACCESS_LABEL[t.access]}
                </span>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">{t.description}</p>
            </div>
          </div>
          {t.params.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 px-5 sm:px-6 py-4">No parameters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500 bg-slate-50/60 dark:bg-white/[0.02]">
                    <th className="py-2.5 px-5 sm:px-6 font-bold">Name</th>
                    <th className="py-2.5 px-3 font-bold">Type</th>
                    <th className="py-2.5 px-3 font-bold">Required</th>
                    <th className="py-2.5 px-3 pr-5 sm:pr-6 font-bold">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-900">
                  {t.params.map((p) => (
                    <tr key={p.name}>
                      <td className="py-2.5 px-5 sm:px-6 align-top">
                        <code className="text-emerald-600 dark:text-emerald-400 font-bold whitespace-nowrap">{p.name}</code>
                      </td>
                      <td className="py-2.5 px-3 align-top">
                        <code className="text-slate-400 dark:text-slate-500 text-xs whitespace-nowrap">
                          {p.enum ? p.enum.map((e) => `"${e}"`).join(" | ") : p.type}
                        </code>
                      </td>
                      <td className="py-2.5 px-3 align-top">
                        {p.required ? (
                          <span className="text-[10px] font-black uppercase tracking-widest text-red-500">Required</span>
                        ) : (
                          <span className="text-[10px] font-medium uppercase tracking-widest text-slate-300 dark:text-slate-600">Optional</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 pr-5 sm:pr-6 align-top text-slate-500 dark:text-slate-400">
                        {p.description}
                        {p.note && <span className="block text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{p.note}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
