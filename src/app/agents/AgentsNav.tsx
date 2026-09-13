"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  { label: "SDK", href: "/agents/sdk" },
  { label: "Channels", href: "/agents/channels" },
  { label: "About", href: "/agents/about" },
];

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
    </nav>
  );
}
