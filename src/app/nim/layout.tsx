import type { Metadata, Viewport } from 'next';

// ⚡ nim.abapays.com — AbaPay as a Nimiq Pay mini app, paid in NIM only. middleware.ts rewrites the
// nim.abapays.com host onto this route tree. The page runs inside Nimiq Pay's WebView, where the
// wallet is injected as window.nimiq (src/app/nim/NimApp.tsx); opened in an ordinary browser it
// explains how to open it in Nimiq Pay instead.

export const metadata: Metadata = {
  title: { absolute: 'AbaPay for Nimiq Pay — pay Nigerian bills with NIM' },
  description: 'Buy airtime and data, pay electricity and cable TV, buy exam PINs, send money to Nigerian bank accounts and top up phones in 140+ countries, paid in NIM from Nimiq Pay.',
  alternates: { canonical: 'https://nim.abapays.com/' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#1F2348',
};

export default function NimLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen bg-[#F8F8F8] dark:bg-[#14162B] text-[#1F2348] dark:text-slate-100 font-sans">{children}</main>;
}
