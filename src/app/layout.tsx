import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AbaPay | Seamless Payments",
  description: "AbaPay: Decentralized Utility & Fiat Settlement Layer
AbaPay is a Web3-native infrastructure platform designed to eliminate the friction of off-ramping digital assets in emerging markets. Built as a direct-to-utility settlement gateway, AbaPay allows users of non-custodial wallets (such as Celo MiniPay) to seamlessly execute stablecoin transactions that instantly settle as real-world fiat value—covering electricity, telecommunications, and education infrastructure. Engineered with a Next.js/Supabase architecture, the platform features automated concurrent routing, enterprise-grade fiat API integrations, and smart-fallback notification systems, effectively bridging the gap between decentralized finance and everyday utility.",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  other: {
    "talentapp:project_verification": "16d69b905a69b32dac428a7080e67a7c4b61c0b6fde7a037be4639ba1031686e2f495a23013e42f1b9ebcd017c92d5f5d32fe10e95bc72cfa1b173658d925cc8",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
