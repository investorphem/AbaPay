import Link from "next/link";
import AgentsNav from "./AgentsNav";
import AgentsFooter from "./AgentsFooter";
import ThemeToggle from "./ThemeToggle";

// ⚡ SHARED CHROME FOR EVERY /agents/* PAGE — header, nav, theme toggle, footer live here
// exactly once, so no individual page can accidentally render its own second footer (the
// exact bug the single-page version had) or a different header. Every page under this layout
// returns only its own content sections; this file owns everything else.
export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans transition-colors">
      <div className="max-w-4xl mx-auto p-4 sm:p-8 pb-20">

        <div className="flex items-center justify-between gap-4 mb-8">
          <Link href="/agents" className="flex items-center gap-2 font-black tracking-tight text-lg text-slate-900 dark:text-white flex-shrink-0">
            AbaPay <span className="text-emerald-500">Rails</span>
          </Link>
          <AgentsNav />
          <div className="hidden lg:flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 px-2.5 py-1 rounded-full flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Celo mainnet
          </div>
          <ThemeToggle />
        </div>

        {children}

        <AgentsFooter />
      </div>
    </main>
  );
}
