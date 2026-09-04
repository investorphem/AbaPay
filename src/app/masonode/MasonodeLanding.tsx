"use client";

import { useEffect, useState } from "react";
import {
  Cloud,
  Server,
  Network,
  ShieldCheck,
  Lock,
  ArrowRight,
  Building2,
  Rocket,
  Landmark,
  Store,
  Mail,
} from "lucide-react";

// ⚡ MASONODE TECHNOLOGIES — PREMIUM LANDING PAGE
//
// A "use client" component (not the route's page.tsx, which stays a server component so it
// can export `metadata`) because the carousel below is interval-driven React state.
//
// 🔴 NO STOCK PHOTOGRAPHY OF PEOPLE OR OFFICES. Asked for "technology images or human" —
// deliberately not done with photos: there is no real photography of Masonode's team or
// premises to use, and pulling generic stock imagery off the web would mean shipping pictures
// of strangers on a page that represents a real, specific company to a bank's verification
// team. The visual language instead comes from the client's own mark — the connected-node "M"
// logo — extended into an animated node/network motif that runs through the hero, the section
// dividers and the card hover states. It reads as more deliberately "this company's brand"
// than interchangeable stock photos would anyway.

const SERVICES = [
  {
    icon: Cloud,
    title: "Cloud Computing",
    description: "Scalable cloud storage and compute infrastructure built for reliability under real production load.",
  },
  {
    icon: Server,
    title: "Enterprise Software Development",
    description: "Custom software architectures designed around how a specific business actually operates, not a generic template.",
  },
  {
    icon: Network,
    title: "Digital System Integration",
    description: "Connecting the systems a business already runs into one coherent, maintainable technology stack.",
  },
  {
    icon: Lock,
    title: "Secure Transaction Processing",
    description: "Transaction processing systems built with security and auditability as first-class requirements, not an afterthought.",
  },
];

const CUSTOMERS = [
  {
    icon: Building2,
    title: "Corporate Enterprises",
    description: "Established organizations that need infrastructure to match the scale they already operate at.",
  },
  {
    icon: Rocket,
    title: "Tech-Driven Startups",
    description: "Fast-moving teams that need to ship on solid architecture from day one, not retrofit it later.",
  },
  {
    icon: Landmark,
    title: "Financial Institutions",
    description: "Regulated environments where secure transaction processing and auditability are non-negotiable.",
  },
  {
    icon: Store,
    title: "Digital Merchants",
    description: "Businesses transacting online that need infrastructure as reliable as the storefront it runs.",
  },
];

/** Animated background: nodes and connecting lines, echoing the logo's own motif. Pure SVG, no deps. */
function NodeNetwork({ className = "" }: { className?: string }) {
  const nodes = [
    { x: 60, y: 80 }, { x: 220, y: 40 }, { x: 380, y: 110 }, { x: 540, y: 50 },
    { x: 150, y: 220 }, { x: 320, y: 260 }, { x: 480, y: 200 }, { x: 640, y: 260 },
    { x: 90, y: 340 }, { x: 260, y: 380 }, { x: 420, y: 340 }, { x: 580, y: 380 },
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [5, 6], [6, 7], [4, 8], [5, 9], [9, 10], [10, 11], [6, 10],
  ];
  return (
    <svg
      viewBox="0 0 700 420"
      className={className}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="edgeGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#93c5fd" stopOpacity="0.15" />
        </linearGradient>
        <radialGradient id="nodeGrad">
          <stop offset="0%" stopColor="#bfdbfe" />
          <stop offset="100%" stopColor="#3b82f6" />
        </radialGradient>
      </defs>
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y}
          stroke="url(#edgeGrad)" strokeWidth="1.5"
          className="masonode-edge"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
      {nodes.map((n, i) => (
        <circle
          key={i}
          cx={n.x} cy={n.y} r={i % 3 === 0 ? 5 : 3.5}
          fill="url(#nodeGrad)"
          className="masonode-node"
          style={{ animationDelay: `${i * 0.22}s` }}
        />
      ))}
    </svg>
  );
}

export default function MasonodeLanding() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActive((i) => (i + 1) % CUSTOMERS.length), 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="min-h-screen bg-[#05070c] text-slate-100 overflow-x-hidden">
      <style>{`
        @keyframes masonodeFadeUp { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes masonodePulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
        @keyframes masonodeDash { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
        @keyframes masonodeGlow { 0%, 100% { opacity: 0.5; transform: scale(1); } 50% { opacity: 0.85; transform: scale(1.06); } }
        .masonode-fade-up { animation: masonodeFadeUp 0.8s ease-out both; }
        .masonode-node { animation: masonodePulse 3s ease-in-out infinite; }
        .masonode-edge { stroke-dasharray: 6 6; animation: masonodeDash 3.5s linear infinite; }
        .masonode-glow { animation: masonodeGlow 6s ease-in-out infinite; }
        .masonode-card { transition: transform 0.35s ease, border-color 0.35s ease, box-shadow 0.35s ease; }
        .masonode-card:hover { transform: translateY(-4px); border-color: rgba(96,165,250,0.5); box-shadow: 0 20px 60px -20px rgba(59,130,246,0.35); }
      `}</style>

      {/* ── Header ── */}
      <header className="relative z-20 border-b border-white/5 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/masonode-logo.png" alt="Masonode Technologies" className="h-9 w-9 object-contain" />
            <span className="text-base font-semibold tracking-tight text-white">Masonode Technologies</span>
          </div>
          <a
            href="#contact"
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors flex items-center gap-1.5"
          >
            Contact <ArrowRight size={14} />
          </a>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-blue-600/10 blur-[140px] masonode-glow" />
          <NodeNetwork className="absolute inset-0 w-full h-full opacity-60" />
        </div>

        <div className="relative mx-auto max-w-6xl px-6 pt-24 pb-28 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/masonode-logo.png"
            alt="Masonode Technologies"
            className="h-24 w-24 object-contain mb-8 drop-shadow-[0_0_40px_rgba(59,130,246,0.45)] masonode-fade-up"
          />
          <p
            className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-400 mb-5 masonode-fade-up"
            style={{ animationDelay: "0.1s" }}
          >
            Digital Infrastructure &amp; Enterprise Software
          </p>
          <h1
            className="text-4xl sm:text-6xl font-bold tracking-tight text-white max-w-3xl leading-[1.1] masonode-fade-up"
            style={{ animationDelay: "0.2s" }}
          >
            Secure, scalable technology for businesses built to last.
          </h1>
          <p
            className="mt-6 text-lg text-slate-400 max-w-2xl leading-relaxed masonode-fade-up"
            style={{ animationDelay: "0.3s" }}
          >
            Masonode Technologies Limited is an innovative digital infrastructure provider
            specializing in cutting-edge cloud computing, enterprise software development, and
            digital system integration.
          </p>
          <div
            className="mt-10 flex flex-wrap items-center justify-center gap-3 masonode-fade-up"
            style={{ animationDelay: "0.4s" }}
          >
            <a
              href="#contact"
              className="rounded-full bg-white text-slate-900 px-7 py-3 text-sm font-semibold hover:bg-blue-50 transition-colors shadow-lg shadow-blue-950/50"
            >
              Get in Touch
            </a>
            <a
              href="#services"
              className="rounded-full border border-white/15 text-slate-200 px-7 py-3 text-sm font-semibold hover:border-white/30 hover:bg-white/5 transition-colors"
            >
              What We Do
            </a>
          </div>
        </div>
      </section>

      {/* ── Trust strip ── */}
      <section className="relative border-y border-white/5 bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-6 py-6 flex flex-wrap items-center justify-center gap-x-12 gap-y-3">
          {["B2B Technology Model", "Secure API Integrations", "Dedicated Infrastructure", "Enterprise-Grade Reliability"].map((t) => (
            <span key={t} className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400">
              <ShieldCheck size={14} className="text-blue-500" />
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* ── Services ── */}
      <section id="services" className="relative mx-auto max-w-6xl px-6 py-24">
        <div className="mb-14 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-400 mb-3">What We Do</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">Core Services</h2>
          <p className="mt-4 text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Robust digital infrastructure, scalable cloud storage solutions, secure transaction
            processing systems, and custom software architectures tailored for modern businesses.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          {SERVICES.map((s) => (
            <div
              key={s.title}
              className="masonode-card rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent p-7"
            >
              <div className="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-5">
                <s.icon size={20} className="text-blue-400" />
              </div>
              <h3 className="font-semibold text-white mb-2 text-lg">{s.title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{s.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Who we serve — carousel ── */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-24 overflow-hidden">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-14 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-400 mb-3">Who We Serve</p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">Built for Every Scale</h2>
          </div>

          <div className="relative max-w-2xl mx-auto">
            <div className="relative h-56 sm:h-48">
              {CUSTOMERS.map((c, i) => (
                <div
                  key={c.title}
                  className="absolute inset-0 flex flex-col items-center text-center transition-all duration-700 ease-out"
                  style={{
                    opacity: active === i ? 1 : 0,
                    transform: active === i ? "translateY(0)" : "translateY(12px)",
                    pointerEvents: active === i ? "auto" : "none",
                  }}
                >
                  <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-5">
                    <c.icon size={26} className="text-blue-400" />
                  </div>
                  <h3 className="text-xl font-semibold text-white mb-2">{c.title}</h3>
                  <p className="text-slate-400 leading-relaxed max-w-md">{c.description}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-center gap-2 mt-8">
              {CUSTOMERS.map((c, i) => (
                <button
                  key={c.title}
                  onClick={() => setActive(i)}
                  aria-label={`Show ${c.title}`}
                  className={`h-1.5 rounded-full transition-all ${active === i ? "w-8 bg-blue-500" : "w-1.5 bg-white/20 hover:bg-white/40"}`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Operating model ── */}
      <section className="relative mx-auto max-w-6xl px-6 py-24">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-400 mb-3">How We Operate</p>
            <h2 className="text-3xl font-bold tracking-tight text-white mb-6">A B2B technology model, built for scale.</h2>
            <p className="text-slate-400 leading-relaxed mb-6">
              We operate a B2B technology model, delivering scalable digital services through
              secure API integrations and dedicated infrastructure deployment — built for
              performance, safety, and operational efficiency at the scale our clients need.
            </p>
            <ul className="space-y-3">
              {["Secure API-first integration", "Dedicated infrastructure deployment", "Operational efficiency at scale"].map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm text-slate-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative h-72 rounded-3xl border border-white/10 bg-gradient-to-br from-blue-500/10 via-transparent to-transparent overflow-hidden">
            <NodeNetwork className="absolute inset-0 w-full h-full opacity-80" />
          </div>
        </div>
      </section>

      {/* ── Contact / footer ── */}
      <footer id="contact" className="relative border-t border-white/5">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-400 mb-3">Get in Touch</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-5">Let&apos;s build something reliable.</h2>
          <p className="text-slate-400 mb-8 max-w-xl mx-auto">
            For partnership, integration, or general inquiries, reach out and a member of our
            team will respond.
          </p>
          <a
            href="mailto:hello@abapays.com"
            className="inline-flex items-center gap-2 rounded-full bg-white text-slate-900 px-8 py-3.5 text-sm font-semibold hover:bg-blue-50 transition-colors shadow-lg shadow-blue-950/50"
          >
            <Mail size={16} />
            hello@abapays.com
          </a>

          <div className="mt-20 flex flex-col items-center gap-4 border-t border-white/5 pt-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/masonode-logo.png" alt="Masonode Technologies" className="h-8 w-8 object-contain opacity-70" />
            <p className="text-xs text-slate-500">
              © {new Date().getFullYear()} Masonode Technologies Limited. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
