"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export type TourTab = "pay" | "bank" | "education" | "history" | "agent";

interface TourStep {
  target: string | null; // matches a [data-tour="..."] element; null = centered card, no spotlight
  tab?: TourTab;          // tab that must be active for the target to exist
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    target: null,
    title: "👋 Welcome to AbaPay",
    body: "Quick 60-second look around — pay bills, send money, and manage your wallet from one screen. Tap Next to begin, or Cancel to explore on your own.",
  },
  {
    target: "tabs-bar", tab: "pay",
    title: "Your five sections",
    body: "Everything lives under one of these tabs: Bills, Transfer, Education, History, and Agent.",
  },
  {
    target: "services", tab: "pay",
    title: "Bills — airtime, data & more",
    body: "Pick a service — Airtime, Data, Electricity, Cable or Internet — fill in the details, and pay in seconds.",
  },
  {
    target: "bank-tab", tab: "bank",
    title: "Transfer",
    body: "Send money straight to any Nigerian bank account, paid for from your crypto balance.",
  },
  {
    target: "education-tab", tab: "education",
    title: "Education",
    body: "Buy WAEC or JAMB result-checker PINs instantly.",
  },
  {
    target: "history-tab", tab: "history",
    title: "History",
    body: "Every payment you've made lives here, with receipts you can revisit or get support on.",
  },
  {
    target: "agent-tab", tab: "agent",
    title: "Agent — pay from chat",
    body: "Link WhatsApp, Telegram or X so AbaPay can pay bills for you right from a chat message — set a spend limit once, including for recurring bills.",
  },
  {
    target: "wallet-connect",
    title: "Wallet, network & region",
    body: "Connect a wallet, switch between Celo and Base, track referral points, and set your country here.",
  },
  {
    target: "ai-chat",
    title: "Ask the AI assistant",
    body: "Not sure where something is? Describe what you want in plain English here and let AbaPay fill the form for you.",
  },
  {
    target: null,
    title: "🎉 You're all set!",
    body: "That's the tour. Replay it anytime from the compass icon next to your region.",
  },
];

const STORAGE_KEY = "abapay_tour_done";

export function hasSeenTour(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

interface AppTourProps {
  active: boolean;
  onFinish: () => void;
  onTabChange: (tab: TourTab) => void;
}

export default function AppTour({ active, onFinish, onTabChange }: AppTourProps) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  const current = TOUR_STEPS[Math.min(step, TOUR_STEPS.length - 1)];

  const measure = useCallback(() => {
    if (!current.target) { setRect(null); return; }
    const el = document.querySelector(`[data-tour="${current.target}"]`);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [current.target]);

  // On entering a step: switch to the tab it lives on (if any), then locate + scroll to it.
  useEffect(() => {
    if (!active) return;
    if (current.tab) onTabChange(current.tab);
    const t = setTimeout(() => {
      const el = current.target ? document.querySelector(`[data-tour="${current.target}"]`) : null;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      measure();
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, step]);

  // Keep the spotlight glued to its target while the tour is up (scroll/resize/orientation).
  useEffect(() => {
    if (!active) return;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [active, measure]);

  // Reset back to step 0 each time the tour is (re)started.
  useEffect(() => {
    if (active) setStep(0);
  }, [active]);

  if (!active) return null;

  const finish = () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    onFinish();
  };
  const next = () => (step >= TOUR_STEPS.length - 1 ? finish() : setStep((s) => s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const PAD = 8;
  const spot = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 400;
  const cardWidth = Math.min(340, viewportW - 32);
  const estCardHeight = 210;

  let top: number;
  let left: number;
  if (!spot) {
    top = viewportH / 2 - estCardHeight / 2;
    left = viewportW / 2 - cardWidth / 2;
  } else {
    const spaceBelow = viewportH - (spot.top + spot.height);
    if (spaceBelow > estCardHeight + 24) {
      top = spot.top + spot.height + 16;
    } else if (spot.top > estCardHeight + 24) {
      top = spot.top - estCardHeight - 16;
    } else {
      top = Math.min(spot.top + spot.height + 16, viewportH - estCardHeight - 16);
    }
    left = Math.min(Math.max(spot.left, 16), viewportW - cardWidth - 16);
  }
  top = Math.max(16, Math.min(top, viewportH - 16));

  const cardStyle: CSSProperties = { top, left, width: cardWidth };

  return (
    <div className="fixed inset-0 z-[200]">
      {spot ? (
        <div
          className="absolute rounded-2xl ring-2 ring-emerald-400 transition-all duration-300 ease-out pointer-events-none"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height, boxShadow: "0 0 0 9999px rgba(4,8,6,0.72)" }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/70" />
      )}

      <div
        className="absolute bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl p-5 animate-in fade-in zoom-in-95"
        style={cardStyle}
      >
        <p className="text-[10px] font-black uppercase tracking-widest text-emerald-500 mb-1">
          Step {step + 1} of {TOUR_STEPS.length}
        </p>
        <h3 className="text-base font-black text-slate-900 dark:text-white mb-1.5">{current.title}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-snug mb-4">{current.body}</p>
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={finish}
            className="text-[11px] font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 uppercase tracking-widest"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={back}
                className="px-3 py-2 rounded-xl text-xs font-black uppercase tracking-widest text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={next}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black uppercase tracking-widest shadow-sm active:scale-95 transition-all"
            >
              {step >= TOUR_STEPS.length - 1 ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
