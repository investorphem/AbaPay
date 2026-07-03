import type { NextConfig } from "next";

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
        ],
      },
    ];
  },
};

export default nextConfig;
