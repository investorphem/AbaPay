"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";

// ⚡ A REAL CONTROL, NOT JUST A SYSTEM-PREFERENCE FOLLOW — the redesign that shipped without
// this assumed "respects the OS setting" was enough, but a viewer without an easy OS-level
// toggle (or who just wants this one site to look a specific way regardless of the rest of
// their machine) had no way to change it here. One button, cycles system -> light -> dark ->
// system. Deliberately simpler than AppFooter's spring-loaded three-button version (this is a
// standalone site with its own restrained visual language, not the consumer app).
const ORDER = ["system", "light", "dark"] as const;

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="w-8 h-8" />;

  const current = (theme as (typeof ORDER)[number]) || "system";
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  return (
    <button
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${current} (click for ${next})`}
      title={`Theme: ${current}`}
      className="w-8 h-8 rounded-full flex items-center justify-center bg-slate-100 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
    >
      <Icon size={14} />
    </button>
  );
}
