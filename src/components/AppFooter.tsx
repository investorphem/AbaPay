import React from 'react';
import Link from 'next/link';
import { ShieldCheck, Send } from 'lucide-react';

export default function AppFooter() {
  return (
    <footer className="mt-12 w-full border-t border-slate-200 pt-8 pb-4 flex flex-col items-center gap-5 animate-in fade-in">
      <div className="flex items-center gap-4">
        <a href="https://x.com/AbaPays" target="_blank" rel="noopener noreferrer" className="w-12 h-12 rounded-full border-2 border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-all shadow-sm group">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:scale-110 transition-transform">
            <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"></path>
          </svg>
        </a>
        <a href="https://t.me/AbaPays" target="_blank" rel="noopener noreferrer" className="w-12 h-12 rounded-full border-2 border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-all shadow-sm group">
          <Send size={20} className="ml-[-2px] mt-[2px] group-hover:scale-110 transition-transform" /> 
        </a>
      </div>
      <div className="flex items-center gap-2.5 bg-white px-4 py-1.5 rounded-full shadow-sm border border-slate-100">
         <ShieldCheck size={16} className="text-emerald-600" />
         <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Secured by Celo Network</span>
      </div>
      <div className="flex gap-6">
        <Link href="/docs" className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase transition-colors">Docs & FAQ</Link>
        <Link href="/terms" className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase transition-colors">Terms</Link>
        <Link href="/privacy" className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase transition-colors">Privacy</Link>
      </div>
      <p className="text-[9px] font-medium text-slate-300 uppercase tracking-[0.2em] mt-1">© 2026 MASONODE TECHNOLOGIES LIMITED • v3.0</p>
    </footer>
  );
}
