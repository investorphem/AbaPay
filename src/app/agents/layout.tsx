import Link from "next/link";
import Image from "next/image";
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
      {/* ⚡ WIDENED, DELIBERATELY — this was max-w-4xl (56rem/896px), cramped once pages started
          carrying real reference tables (tool schemas, error codes) rather than just prose.
          max-w-6xl (72rem/1152px) gives those tables room on a real desktop monitor without
          prose sections feeling too wide — individual paragraphs still cap themselves at
          max-w-2xl/3xl internally, this only widens the outer shell and header row. */}
      <div className="max-w-6xl mx-auto px-4 sm:px-8 lg:px-12 py-4 sm:py-8 pb-20">

        <div className="flex items-center justify-between gap-4 sm:gap-6 mb-10">
          <Link href="/agents" className="flex items-center gap-2 font-black tracking-tight text-lg text-slate-900 dark:text-white flex-shrink-0">
            <Image src="/logo.png" alt="" width={28} height={28} className="object-contain" priority />
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
