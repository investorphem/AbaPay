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

// ⚡ 1. FARCASTER V2 MINI-APP CONFIG ⚡
// This perfectly meets Farcaster's requirements for a "Launch" button app
const farcasterConfig = {
  version: "1",
  imageUrl: "https://abapays.com/og-image.png", 
  button: {
    title: "Launch AbaPay", 
    action: {
      type: "launch_frame",
      name: "AbaPay",
      url: "https://abapays.com/", 
      splashImageUrl: "https://abapays.com/logo.png", 
      splashBackgroundColor: "#f8fafc" 
    }
  }
};

// ⚡ 2. THE UNIFIED METADATA (Satisfies Base & Farcaster) ⚡
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
  // Base App Crawler specifically looks for this OpenGraph data!
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
        alt: "AbaPay",
      }
    ],
  },
  other: {
    // 🔵 BASE APP REQUIREMENT
    "base:app_id": "69ef61fe7bbc513a443f26e4",
    
    // 🟣 FARCASTER APP REQUIREMENT
    "fc:frame": JSON.stringify(farcasterConfig),
    
    // 🟢 TALENT APP REQUIREMENT
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