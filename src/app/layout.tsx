import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import { ThemeProvider } from "next-themes"; // ⚡ IMPORT NEXT-THEMES

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// ⚡ FARCASTER MINI-APP METADATA ⚡
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
    // Your existing TalentApp verification
    "talentapp:project_verification": "16d69b905a69b32dac428a7080e67a7c4b61c0b6fde7a037be4639ba1031686e2f495a23013e42f1b9ebcd017c92d5f5d32fe10e95bc72cfa1b173658d925cc8",
    // ⚡ Tells Farcaster to render the Mini-App ⚡
    "fc:frame": JSON.stringify(farcasterFrameConfig),
    // ⚡ Base App Verification ⚡
    "base:app_id": "69ef3dd6e6b83cf73ad1dbb4",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // ⚡ ADDED suppressHydrationWarning SO NEXT.JS DOESN'T COMPLAIN ABOUT THEME INJECTION ⚡
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* ⚡ THEME PROVIDER WRAPPING THE APP (Defaults to Dark Mode) ⚡ */}
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          {/* ⚡ WAGMI PROVIDERS WRAPPER ⚡ */}
          <Providers>
            {children}
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}