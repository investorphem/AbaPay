import type { NextConfig } from "next";

// 🔐 CONTENT SECURITY POLICY (Audit v2, M-4)
//
// CSP is shipped in REPORT-ONLY mode first, on purpose. A Web3 app's wallet SDKs use inline
// scripts, WebSocket connections to relays, and calls to many RPC/API domains — an overly
// strict *enforcing* CSP silently breaks wallet connection for ALL users, which is far worse
// than having no CSP. Report-Only surfaces violations in the browser console + (optionally) a
// report endpoint WITHOUT blocking anything.
//
// ROLLOUT: deploy this, open the app, connect a wallet, run every flow, and watch the console
// for "Content-Security-Policy-Report-Only" violations. Add any legitimately-needed origins
// below, then flip the header key from "Content-Security-Policy-Report-Only" to
// "Content-Security-Policy" to enforce.
const cspReportOnly = [
  "default-src 'self'",
  // Next.js requires 'unsafe-inline'/'unsafe-eval' for its runtime; wallet SDKs also use eval.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Wallets/RPC/relays/APIs the app talks to. Broad https+wss during rollout; tighten later.
  "connect-src 'self' https: wss:",
  // Farcaster/MiniPay embed the app in an iframe — do not use frame-ancestors 'none'.
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  // 🔐 Hide the framework fingerprint from attackers
  poweredByHeader: false,

  // 🔐 Enterprise security headers on every response.
  // Note: X-Frame-Options is intentionally omitted so the Farcaster miniapp embed keeps working.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          // Report-only during rollout — see note above before enforcing.
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
    ];
  },
};

export default nextConfig;
