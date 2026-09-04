import type { Metadata } from "next";
import MasonodeLanding from "./MasonodeLanding";

// ⚡ MASONODE TECHNOLOGIES — CORPORATE LANDING PAGE
//
// Served at app.abapays.com (see middleware.ts, which rewrites every request on that host
// to this route regardless of path). Exists for one reason: Monnify's business-verification
// step for the Masonode Technologies merchant account rejects a bare Vercel deployment URL
// and asks for "a fully functioning website link" on a real domain. This is that link.
//
// Split into this server component (metadata only — Next.js won't let a Client Component
// export `metadata`) and MasonodeLanding, the actual page, which needs "use client" for the
// carousel's interval-driven state.
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
    images: ["https://app.abapays.com/masonode-logo.png"],
  },
};

export default function MasonodePage() {
  return <MasonodeLanding />;
}
