'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Overview / Celo / Base. The pathname is the browser's, so on stats.abapays.com it is /, /celo or
// /base, and at the /stats fallback (previews, localhost) it is /stats, /stats/celo or /stats/base.
export default function StatsNav({ overview, celo, base }: { overview: string; celo: string; base: string }) {
  const pathname = usePathname() ?? '/';
  const page = pathname.endsWith('/celo') ? 'celo' : pathname.endsWith('/base') ? 'base' : 'overview';
  const links = [
    { key: 'overview', label: 'Overview', href: overview },
    { key: 'celo', label: 'Celo', href: celo },
    { key: 'base', label: 'Base', href: base },
  ];
  return (
    <nav className="flex items-center gap-1 rounded-full border border-slate-200 dark:border-slate-800 p-0.5" aria-label="Chain">
      {links.map((l) => (
        <Link
          key={l.key}
          href={l.href}
          aria-current={page === l.key ? 'page' : undefined}
          className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest ${page === l.key ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400'}`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
