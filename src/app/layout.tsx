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

// ⚡ THE MASTER METADATA ⚡
export const metadata: Metadata = {
  metadataBase: new URL("https://abapays.com"),
  title: "AbaPay | Seamless Payments",
  description: "AbaPay is a Web3-native infrastructure platform eliminating off-ramp friction. Instantly settle stablecoin transactions into real-world fiat utility value.",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    title: "AbaPay | Seamless Payments",
    description: "Instantly settle stablecoin transactions into real-world fiat utility value.",
    url: "https://abapays.com",
    siteName: "AbaPay",
    type: "website",
    images: [
      {
        url: "https://abapays.com/og-image.png",
        width: 1200,
        height: 630,
        alt: "AbaPay Mini App",
      }
    ],
  },
  other: {
    // ⚡ 1. YOUR BASE APP ID (Passes the first check)
    "base:app_id": "69ef61fe7bbc513a443f26e4",
    
    // ⚡ 2. FARCASTER V1 FRAME TAGS (Fixes the "must have metadata" error)
    "fc:frame": "vNext",
    "fc:frame:image": "https://abapays.com/og-image.png",
    "fc:frame:button:1": "Launch AbaPay",
    "fc:frame:button:1:action": "link",
    "fc:frame:button:1:target": "https://abapays.com/",
    
    // ⚡ 3. TalentApp Verification
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
