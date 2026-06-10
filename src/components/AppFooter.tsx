"use client";

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { ShieldCheck, Send, Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from "next-themes";

interface AppFooterProps {
  network?: string;
}



  

  const handleMainClick = () => {
    if (isOpen) {
      setIsOpen(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    } else {
      openToggle();
    }
  };

  const selectTheme = (newTheme: string) => {
    setTheme(newTheme);
    setIsOpen(false);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  };

  if (!mounted) return <div className="w-7 h-7" />;

  const ActiveIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <div className="relative flex items-center justify-center">
      
      {/* Option 1: Light Mode (Springs out to the far left) */}
      <button 
        onClick={() => selectTheme('light')} 
        className={`absolute w-7 h-7 rounded-full flex items-center justify-center bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-emerald-500 shadow-md transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isOpen ? 'translate-x-[-40px] translate-y-[-5px] opacity-100 scale-100' : 'translate-x-0 translate-y-0 opacity-0 scale-50 pointer-events-none'}`}
      >
        <Sun size={12} />
      </button>
      
      {/* Option 2: System Mode (Springs out to the top-left diagonal) */}
      <button 
        onClick={() => selectTheme('system')} 
        className={`absolute w-7 h-7 rounded-full flex items-center justify-center bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-emerald-500 shadow-md transition-all duration-300 delay-75 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isOpen ? 'translate-x-[-30px] translate-y-[-30px] opacity-100 scale-100' : 'translate-x-0 translate-y-0 opacity-0 scale-50 pointer-events-none'}`}
      >
        <Monitor size={12} />
      </button>

      {/* Option 3: Dark Mode (Springs out straight up) */}
      <button 
        onClick={() => selectTheme('dark')} 
        className={`absolute w-7 h-7 rounded-full flex items-center justify-center bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-emerald-500 shadow-md transition-all duration-300 delay-150 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${isOpen ? 'translate-x-[-5px] translate-y-[-40px] opacity-100 scale-100' : 'translate-x-0 translate-y-0 opacity-0 scale-50 pointer-events-none'}`}
      >
        <Moon size={12} />
      </button>

      {/* ⚡ MAIN TRIGGER BUTTON ⚡ */}
      <button 
        onClick={handleMainClick} 
        className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-300 shadow-sm border ${isOpen ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 border-emerald-200 dark:border-emerald-800/50 scale-110' : 'bg-slate-100 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 border-transparent hover:bg-slate-200 dark:hover:bg-slate-800 active:scale-95'}`}
      >
        <ActiveIcon size={14} />
      </button>
    </div>
  );
}

export default function AppFooter({ network = "Base & Celo" }: AppFooterProps) {
  return (
    <footer className="mt-12 w-full border-t border-slate-200 dark:border-slate-800/60 pt-8 pb-4 flex flex-col items-center gap-5 animate-in fade-in transition-colors">
      
      <div className="flex items-center gap-4">
        <a href="https://x.com/AbaPays" target="_blank" rel="noopener noreferrer" className="w-12 h-12 rounded-full border-2 border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111114] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-900 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all shadow-sm group">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:scale-110 transition-transform">
            <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"></path>
          </svg>
        </a>
        <a href="https://t.me/AbaPays" target="_blank" rel="noopener noreferrer" className="w-12 h-12 rounded-full border-2 border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111114] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-900 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all shadow-sm group">
          <Send size={20} className="ml-[-2px] mt-[2px] group-hover:scale-110 transition-transform" /> 
        </a>
      </div>

      {/* ⚡ DYNAMIC NETWORK BADGE ⚡ */}
      <div className="flex items-center gap-2.5 bg-white dark:bg-[#111114] px-4 py-1.5 rounded-full shadow-sm border border-slate-100 dark:border-slate-800 transition-colors">
         <ShieldCheck size={16} className="text-emerald-600" />
         <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Secured by {network} Network</span>
      </div>

      <div className="flex items-center gap-5">
        <Link href="/docs" className="text-[10px] font-black text-slate-400 dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 uppercase transition-colors">Docs & FAQ</Link>
        <Link href="/terms" className="text-[10px] font-black text-slate-400 dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 uppercase transition-colors">Terms</Link>
        
        {/* ⚡ PRIVACY LINK & NEW INLINE THEME TOGGLE ⚡ */}
        <div className="flex items-center gap-3">
           <Link href="/privacy" className="text-[10px] font-black text-slate-400 dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 uppercase transition-colors">Privacy</Link>
           <div className="w-[1px] h-3 bg-slate-300 dark:bg-slate-700 rounded-full"></div>
           <ThemeToggle />
        </div>
      </div>

      <p className="text-[9px] font-medium text-slate-300 dark:text-slate-600 uppercase tracking-[0.2em] mt-1">© 2026 MASONODE TECHNOLOGIES LIMITED • v3.0</p>
    </footer>
  );
}
