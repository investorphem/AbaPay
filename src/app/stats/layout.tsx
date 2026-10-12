import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import ThemeToggle from '../agents/ThemeToggle';
import StatsNav from './StatsNav';
import { statsHref } from '@/lib/onchain/statsUrl';

// ⚡ stats.abapays.com — AbaPay's public on-chain analytics, as its own site (the way
// docs.abapays.com is its own site), not a page inside the agents site. middleware.ts rewrites the
// stats.abapays.com host onto this route tree, so its URLs are stats.abapays.com/, /celo and /base.

export const metadata: Metadata = {
  title: { default: 'AbaPay Analytics', template: '%s — AbaPay Analytics' },
  description: 'Live on-chain analytics for AbaPay: every payment into its vaults on Celo and Base, read directly from the chain.',
};

const OUT = [
  { label: 'Agents', href: 'https://agents.abapays.com' },
  { label: 'Docs', href: 'https://docs.abapays.com' },
  { label: 'App', href: 'https://www.abapays.com' },
];

export default function StatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans transition-colors">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 lg:px-12 py-4 sm:py-8 pb-16">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 mb-8">
          <Link href={statsHref()} className="flex items-center gap-2 font-black tracking-tight text-lg text-slate-900 dark:text-white flex-shrink-0">
            <Image src="/logo.png" alt="" width={28} height={28} className="object-contain" priority />
            AbaPay <span className="text-emerald-500">Analytics</span>
          </Link>
          <div className="flex items-center gap-4 sm:gap-6 order-3 sm:order-none w-full sm:w-auto">
            <StatsNav overview={statsHref()} celo={statsHref('/celo')} base={statsHref('/base')} />
          </div>
          <div className="flex items-center gap-4">
            <nav className="hidden md:flex items-center gap-4">
              {OUT.map((l) => (
                <a key={l.label} href={l.href} className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400">
                  {l.label}
                </a>
              ))}
            </nav>
            <ThemeToggle />
          </div>
        </header>

        {children}

        <footer className="mt-12 pt-6 border-t border-slate-200 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400 dark:text-slate-500">
          <span>© {new Date().getFullYear()} Masonode Technologies Limited · RC 9524980</span>
          <nav className="flex flex-wrap gap-4">
            {OUT.map((l) => (
              <a key={l.label} href={l.href} className="hover:text-emerald-600 dark:hover:text-emerald-400">{l.label}</a>
            ))}
            <a href="https://github.com/investorphem/AbaPay/blob/main/src/lib/onchain/indexer.ts" className="hover:text-emerald-600 dark:hover:text-emerald-400">Source</a>
          </nav>
        </footer>
      </div>
    </main>
  );
}
