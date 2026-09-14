"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, FolderGit2 } from "lucide-react";

// ⚡ REAL PAGES, REAL LINKS — the previous version of this nav pointed at #anchors on one long
// page. Clicking "A2A" now genuinely navigates to /agents/a2a, same as clicking "A2A" on
// usecelina.xyz navigates to usecelina.xyz/a2a. See middleware.ts's AGENT_HOST_SKIP for how
// agents.abapays.com/a2a (clean URL on that host) and abapays.com/agents/a2a (same page,
// reached the "long way") both resolve to this same route.
const LINKS = [
  { label: "Stack", href: "/agents" },
  { label: "x402", href: "/agents/x402" },
  { label: "A2A", href: "/agents/a2a" },
  { label: "MCP", href: "/agents/mcp" },
  { label: "API", href: "/agents/api" },
  { label: "SDK", href: "/agents/sdk" },
  { label: "Channels", href: "/agents/channels" },
  { label: "About", href: "/agents/about" },
];

// ⚡ THE "DEVELOPERS" MENU — everything here is a real page under /agents/developers/*, not a
// link off this site. Each row still carries a small GitHub icon (github: below) as a
// secondary "view the real source" affordance — a way OUT to verify, never the primary way IN.
const DEVELOPER_LINKS = [
  { label: "Overview", href: "/agents/developers", github: "https://github.com/investorphem/AbaPay/blob/main/docs/AGENT_INTEGRATION.md" },
  { label: "Integration guide", href: "/agents/developers/guide", github: "https://github.com/investorphem/AbaPay/blob/main/docs/AGENT_INTEGRATION.md" },
  { label: "Quickstart script", href: "/agents/developers/quickstart", github: "https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs" },
  { label: "Docs & FAQ", href: "/docs", github: null },
  // ⚡ The one deliberate exit off this domain in this menu — the 12-chapter handbook lives
  // on its own GitBook-hosted site (synced from docs/gitbook/ in this repo), not as a subpage
  // here. github points at that same source folder, same pattern as every other row.
  { label: "Full Handbook", href: "https://docs.abapays.com", github: "https://github.com/investorphem/AbaPay/tree/main/docs/gitbook", external: true },
];

function DevelopersMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = pathname?.startsWith("/agents/developers") || pathname === "/docs";

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-1 text-xs font-bold uppercase tracking-widest whitespace-nowrap transition-colors ${
          active ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400"
        }`}
      >
        Developers <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 sm:left-0 top-full mt-3 w-64 bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-2xl shadow-lg py-2 z-20">
          {DEVELOPER_LINKS.map((l) => (
            <div key={l.label} className="flex items-center justify-between gap-2 px-2">
              {l.external ? (
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="flex-1 px-2 py-2 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.03] hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="flex-1 px-2 py-2 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.03] hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                >
                  {l.label}
                </Link>
              )}
              {l.github && (
                <a
                  href={l.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View source on GitHub"
                  aria-label={`View "${l.label}" source on GitHub`}
                  className="p-1.5 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0"
                >
                  <FolderGit2 size={14} />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentsNav() {
  const pathname = usePathname();
  return (
    // Horizontally scrollable rather than hidden below md — a nav a phone visitor can't see
    // at all isn't "responsive," it's missing. -mx-4 px-4 lets it bleed to the true screen
    // edge for a natural scroll affordance without disturbing the header's own padding.
    <nav className="flex items-center gap-5 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {LINKS.map((l) => {
        const active = l.href === "/agents" ? pathname === "/agents" : pathname?.startsWith(l.href);
        return (
          <Link
            key={l.label}
            href={l.href}
            className={`text-xs font-bold uppercase tracking-widest whitespace-nowrap transition-colors ${
              active
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
      <DevelopersMenu />
    </nav>
  );
}
