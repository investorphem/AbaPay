import { http, createConfig, createStorage, cookieStorage, fallback } from 'wagmi';
import { base, baseSepolia, celo, celoAlfajores } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors';
import { rpcUrlsFor } from '@/lib/chain';

// ⚡ PULL IN YOUR WALLETCONNECT ID
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// ⚡ RELAY OVERRIDE — THE MTN / NIGERIA ESCAPE HATCH ⚡
//
// WalletConnect has exactly ONE relay network; you cannot switch "provider". What you CAN
// change is the URL your app reaches it through. Some Nigerian mobile networks (MTN most
// reported) filter `relay.walletconnect.org`, and because the relay is a WebSocket the
// failure is silent — no session, no QR, no error. Point this at a WebSocket reverse proxy
// on a domain of yours that isn't filtered (e.g. wss://relay.abapays.com -> the real relay)
// and every WalletConnect wallet — Valora included — starts working on those networks.
//
// Relay traffic is end-to-end encrypted between wallet and dApp, so a proxy is a pipe, not a
// man-in-the-middle. Note Vercel functions cannot proxy long-lived WebSockets — host the
// proxy on Cloudflare Workers / Fly.io / a VPS with nginx `proxy_pass` + Upgrade headers.
//
// Unset = use WalletConnect's own relay (the default, unchanged behaviour).
const relayUrl = process.env.NEXT_PUBLIC_WC_RELAY_URL || undefined;

// The browser's transports now use the SAME primary+backup list as the server
// (src/lib/chain.ts) via viem's fallback(), instead of a bare http() with one default
// endpoint. A blocked or downed RPC rolls over instead of silently breaking reads.
const transportFor = (chainId: number) => {
  const urls = rpcUrlsFor(chainId);
  return urls.length ? fallback(urls.map((u) => http(u))) : http();
};

export const config = createConfig({
  // ⚡ CELO IS NOW FIRST: Valora and other wallets will default to Celo!
  chains: [celo, celoAlfajores, base, baseSepolia],
  connectors: [
    injected(),
    baseAccount({
      appName: 'AbaPay',
    }),
    // ⚡ THE WALLETCONNECT BRIDGE FOR VALORA & MOBILE WALLETS
    walletConnect({
      projectId,
      showQrModal: true,
      relayUrl,
      // Reown's telemetry (pulse.walletconnect.org) is one more third-party host that can
      // be filtered, and it buys the user nothing. Off.
      telemetryEnabled: false,
      // ⚡ VALORA INTEGRATION: Forces Valora to the top of the recommended list
      qrModalOptions: {
        explorerRecommendedWalletIds: [
          'd01c7758d741b363e637a817a09bcf579feae4db9f5bb16f599fdd1f66e2f974' // Official Valora Wallet ID
        ]
      },
      metadata: {
        name: 'AbaPay',
        description: 'Seamless Crypto Bill Payments',
        // ⚡ DYNAMIC URL: Safely handles Vercel Preview links and the live domain
        url: typeof window !== 'undefined' ? window.location.origin : 'https://abapays.com',
        icons: ['https://abapays.com/logo.png']
      }
    }),
  ],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    // ⚡ TRANSPORTS REORDERED TO MATCH THE CHAINS ARRAY
    [celo.id]: transportFor(celo.id),
    [celoAlfajores.id]: transportFor(celoAlfajores.id),
    [base.id]: transportFor(base.id),
    [baseSepolia.id]: transportFor(baseSepolia.id),
  },
});
