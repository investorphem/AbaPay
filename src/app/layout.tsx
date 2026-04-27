import { Metadata } from "next"; // ⚡ Removed "type" to match Base exactly
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

// ⚡ FARCASTER MINI-APP METADATA CONFIG ⚡
const farcasterFrameConfig = {
  version: "next",
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

export const metadata: Metadata = {
  title: "AbaPay | Seamless Payments",
  description: "AbaPay is a Web3-native infrastructure platform eliminating off-ramp friction. Instantly settle stablecoin transactions into real-world fiat utility value.",
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
  openGraph: {
    title: "AbaPay | Seamless Payments",
    description: "Instantly settle stablecoin transactions into real-world fiat utility value.",
    images: ["https://abapays.com/og-image.png"],
  },
  other: {
    // ⚡ Base App Verification moved to the top
    "base:app_id": "69ef3dd6e6b83cf73ad1dbb4",
    "talentapp:project_verification": "16d69b905a69b32dac428a7080e67a7c4b61c0b6fde7a037be4639ba1031686e2f495a23013e42f1b9ebcd017c92d5f5d32fe10e95bc72cfa1b173658d925cc8",
    "fc:frame": JSON.stringify(farcasterFrameConfig),
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
