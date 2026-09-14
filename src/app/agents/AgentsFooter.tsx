import {
  Bot, ShieldCheck, Fingerprint, FolderGit2, FileText, Building2, Mail, Send, Network, BookOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ⚡ ONE FOOTER, LIVED IN layout.tsx — every /agents/* page renders through that layout, so
// there is now structurally no way for a page to end up with two footers (the bug this
// component's predecessor had: this page's own resource footer sat directly above the shared
// consumer-app AppFooter). AppFooter itself is still never used anywhere under /agents/* —
// this page owns its own, standalone.
//
// ⚡ NO "Developers" COLUMN HERE, DELIBERATELY — AgentsNav's header dropdown already covers
// Overview / Integration Guide / Quickstart / Docs & FAQ. Repeating that list down here was
// the exact kind of duplication a footer is supposed to avoid; the two remaining columns
// (Verify, Company) don't overlap with the header at all, so they stay.
const FOOTER_GROUPS: {
  title: string;
  links: { label: string; href: string; icon: LucideIcon; github?: string }[];
}[] = [
  {
    title: "Verify",
    links: [
      { label: "GitHub repository", href: "https://github.com/investorphem/AbaPay", icon: FolderGit2 },
      { label: "MCP Registry listing", href: "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.investorphem/abapay", icon: Bot },
      { label: "ERC-8004 identity", href: "https://8004scan.io/agents/celo/9760", icon: Fingerprint },
      { label: "Agent Card", href: "/.well-known/agent-card.json", icon: Network },
      { label: "OpenAPI reference", href: "/openapi.json", icon: FileText },
      { label: "Full Handbook", href: "https://docs.abapays.com", icon: BookOpen },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/agents/about", icon: Building2 },
      { label: "Terms", href: "/terms", icon: FileText },
      { label: "Privacy", href: "/privacy", icon: ShieldCheck },
      { label: "Support", href: "mailto:support@abapays.com", icon: Mail },
    ],
  },
];

const SOCIALS = [
  {
    label: "X",
    href: "https://x.com/AbaPays",
    node: (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
      </svg>
    ),
  },
  { label: "Telegram", href: "https://t.me/AbaPays", node: <Send size={16} className="ml-[-1px]" /> },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/masonode/",
    node: (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124zM7.114 20.452H3.558V9h3.556v11.452z"></path>
      </svg>
    ),
  },
];

export default function AgentsFooter() {
  return (
    <footer className="border-t border-slate-200 dark:border-slate-800/60 pt-10 mt-14">
      <div className="grid sm:grid-cols-2 gap-8 mb-10">
        {FOOTER_GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3 px-1">{group.title}</h3>
            <ul className="space-y-0.5">
              {group.links.map((l) => {
                const isExternal = l.href.startsWith("http");
                return (
                  <li key={l.label} className="flex items-center gap-1">
                    <a
                      href={l.href}
                      target={isExternal ? "_blank" : undefined}
                      rel={isExternal ? "noopener noreferrer" : undefined}
                      className="flex-1 min-w-0 flex items-center gap-2.5 py-2 px-1 rounded-lg text-sm text-slate-600 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <l.icon size={14} className="flex-shrink-0 text-slate-400 dark:text-slate-600" />
                      <span className="truncate">{l.label}</span>
                    </a>
                    {l.github && (
                      <a href={l.github} target="_blank" rel="noopener noreferrer" title="View source on GitHub" className="p-1.5 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
                        <FolderGit2 size={13} />
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-5 pt-6 border-t border-slate-100 dark:border-slate-800/60">
        <p className="text-[10px] font-medium text-slate-400 dark:text-slate-600 uppercase tracking-[0.15em] text-center sm:text-left">
          © 2026 Masonode Technologies Limited · RC 9524980
        </p>
        <div className="flex items-center gap-3">
          {SOCIALS.map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={s.label}
              className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111114] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-900 transition-colors"
            >
              {s.node}
            </a>
          ))}
        </div>
      </div>

      {/* The one deliberate, de-emphasized link back to the consumer app. */}
      <p className="text-center text-xs text-slate-400 dark:text-slate-600 mt-8">
        Building a consumer bill-pay experience instead? <a href="https://abapays.com/" className="underline hover:text-emerald-500">abapays.com</a>
      </p>
    </footer>
  );
}
