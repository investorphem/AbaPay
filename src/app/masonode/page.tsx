import type { Metadata } from "next";

// ⚡ MASONODE TECHNOLOGIES — CORPORATE LANDING PAGE
//
// Served at app.abapays.com (see middleware.ts, which rewrites every request on that host
// to this route regardless of path). Exists for one reason: Monnify's business-verification
// step for the Masonode Technologies merchant account rejects a bare Vercel deployment URL
// and asks for "a fully functioning website link" on a real domain. This is that link.
//
// Content below is the business description as given directly by the account holder — not
// generated or embellished. Keep it that way if this page is ever revised: whoever edits it
// should be describing the real business, not writing marketing copy from scratch.
//
// 🔴 metadata is declared HERE, not just inherited from the root layout, because the root
// layout's title/description/OG tags are all "AbaPay" — a KYB reviewer (or anyone else)
// landing on this page should see Masonode Technologies' own identity, not AbaPay's.
export const metadata: Metadata = {
  title: "Masonode Technologies | Digital Infrastructure & Enterprise Software",
  description:
    "Masonode Technologies Limited builds cloud computing, enterprise software, and secure digital infrastructure for corporate enterprises, tech-driven startups, financial institutions, and digital merchants.",
  openGraph: {
    title: "Masonode Technologies",
    description:
      "Digital infrastructure, enterprise software, and secure system integration for modern businesses.",
  },
};

const SERVICES = [
  {
    title: "Cloud Computing",
    description: "Scalable cloud storage and compute infrastructure built for reliability under real production load.",
  },
  {
    title: "Enterprise Software Development",
    description: "Custom software architectures designed around how a specific business actually operates, not a generic template.",
  },
  {
    title: "Digital System Integration",
    description: "Connecting the systems a business already runs into one coherent, maintainable technology stack.",
  },
  {
    title: "Secure Transaction Processing",
    description: "Transaction processing systems built with security and auditability as first-class requirements, not an afterthought.",
  },
];

const CUSTOMERS = [
  "Corporate enterprises",
  "Tech-driven startups",
  "Financial institutions",
  "Digital merchants",
];

export default function MasonodePage() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      {/* ── Header ── */}
      <header className="border-b border-slate-100">
        <div className="mx-auto max-w-5xl px-6 py-6 flex items-center justify-between">
          <span className="text-lg font-bold tracking-tight">Masonode Technologies</span>
          <a
            href="#contact"
            className="text-sm font-semibold text-slate-600 hover:text-slate-900 transition-colors"
          >
            Contact
          </a>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="mx-auto max-w-5xl px-6 pt-20 pb-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-indigo-600 mb-4">
          Digital Infrastructure &amp; Enterprise Software
        </p>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 max-w-3xl leading-tight">
          Digital infrastructure providers building secure, scalable technology for modern businesses.
        </h1>
        <p className="mt-6 text-lg text-slate-600 max-w-2xl leading-relaxed">
          Masonode Technologies Limited is an innovative digital infrastructure provider
          specializing in cutting-edge cloud computing, enterprise software development, and
          digital system integration.
        </p>
      </section>

      {/* ── About / core services description, as given ── */}
      <section className="mx-auto max-w-5xl px-6 py-16 border-t border-slate-100">
        <h2 className="text-2xl font-bold tracking-tight mb-6">About Masonode Technologies</h2>
        <p className="text-slate-600 leading-relaxed max-w-3xl">
          Our core services include building robust digital infrastructure, scalable cloud
          storage solutions, secure transaction processing systems, and custom software
          architectures tailored for modern businesses. We target corporate enterprises,
          tech-driven startups, financial institutions, and digital merchants looking for
          secure, reliable, and high-performance technological frameworks. Operating on a
          robust B2B technology model, we deliver scalable digital services through secure API
          integrations and dedicated infrastructure deployment, ensuring optimal performance,
          safety, and operational efficiency for our clients.
        </p>
      </section>

      {/* ── Services grid ── */}
      <section className="mx-auto max-w-5xl px-6 py-16 border-t border-slate-100">
        <h2 className="text-2xl font-bold tracking-tight mb-8">What We Do</h2>
        <div className="grid sm:grid-cols-2 gap-8">
          {SERVICES.map((s) => (
            <div key={s.title}>
              <h3 className="font-semibold text-slate-900 mb-2">{s.title}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">{s.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Who we serve ── */}
      <section className="mx-auto max-w-5xl px-6 py-16 border-t border-slate-100">
        <h2 className="text-2xl font-bold tracking-tight mb-6">Who We Serve</h2>
        <ul className="flex flex-wrap gap-3">
          {CUSTOMERS.map((c) => (
            <li
              key={c}
              className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
            >
              {c}
            </li>
          ))}
        </ul>
      </section>

      {/* ── Operating model ── */}
      <section className="mx-auto max-w-5xl px-6 py-16 border-t border-slate-100">
        <h2 className="text-2xl font-bold tracking-tight mb-6">How We Operate</h2>
        <p className="text-slate-600 leading-relaxed max-w-3xl">
          We operate a B2B technology model, delivering scalable digital services through
          secure API integrations and dedicated infrastructure deployment — built for
          performance, safety, and operational efficiency at the scale our clients need.
        </p>
      </section>

      {/* ── Contact / footer ── */}
      <footer id="contact" className="border-t border-slate-100 bg-slate-50">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-bold tracking-tight mb-4">Get in Touch</h2>
          <p className="text-slate-600 mb-6 max-w-2xl">
            For partnership, integration, or general inquiries, reach out and a member of our
            team will respond.
          </p>
          <a
            href="mailto:hello@abapays.com"
            className="inline-block rounded-lg bg-slate-900 text-white px-6 py-3 text-sm font-semibold hover:bg-slate-800 transition-colors"
          >
            hello@abapays.com
          </a>
          <p className="mt-12 text-xs text-slate-400">
            © {new Date().getFullYear()} Masonode Technologies Limited. All rights reserved.
          </p>
        </div>
      </footer>
    </main>
  );
}
