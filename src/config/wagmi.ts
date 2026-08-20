import { http, createConfig, fallback } from 'wagmi';
import { base, baseSepolia, celo, celoAlfajores } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors';
import { rpcUrlsFor } from '@/lib/chain';

// ⚡ PULL IN YOUR WALLETCONNECT ID
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// ⚡ RELAY OVERRIDE — THE BLOCKED-NETWORK ESCAPE HATCH ⚡
//
// WalletConnect has exactly ONE relay network; you cannot switch "provider". What you CAN
// change is the URL your app reaches it through. Some networks filter
// `relay.walletconnect.org`, and because the relay is a WebSocket the failure is silent —
// no session, no QR, no error. (Confirmed on at least one carrier: the connect flow works
// over a VPN and hangs without one. We have no data on how many networks are affected, so
// nothing user-facing names a carrier or country.) Point this at a WebSocket reverse proxy
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
  // ⚡ BASE IS FIRST — it is the app's default chain (constants/DEFAULT_CHAIN).
  //
  // wagmi treats chains[0] as the default: it's the chain a freshly connected wallet is
  // asked for, and the one reads fall back to before the user switches. This array was
  // Celo-first while AbaPay was Celo-first; both flipped together. Celo stays fully
  // supported and switchable — nothing is dropped, it just isn't what you land on.
  chains: [base, baseSepolia, celo, celoAlfajores],
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
  // ⚡ NOTHING IS PERSISTED, SO THERE IS NOTHING TO COME BACK BY ITSELF.
  //
  // 🔴 THIS IS THE AUTO-CONNECT THAT SURVIVED TWO FIXES. First the app's own auto-connect rules
  // were narrowed to an allowlist; then `reconnectOnMount={false}` was set on WagmiProvider. It
  // still connected on its own, because neither touches the actual mechanism: this config
  // persisted wagmi's state to `cookieStorage`, so on every load wagmi REHYDRATED
  // `connections`/`current` from the cookie and `useAccount()` reported `isConnected` with an
  // address — no provider set up, no relay socket, just a cookie describing a connection that no
  // longer existed. `reconnectOnMount` governs RE-ESTABLISHING; it does not govern rehydrating.
  //
  // That single fact produced both reported symptoms: the app "auto connects" on a wallet the
  // user never chose, and then paying reports "your wallet connection has dropped — tap Connect"
  // on a wallet that looks connected. Nothing had dropped. There was never a live session.
  //
  // `storage: null` disables the persistence outright, which is the honest expression of what
  // this app now wants: on the web the Connect button is the only way in, so a connection that
  // outlives the page is not a feature to restore. The three surfaces where silent connect IS
  // right are unaffected — MiniPay and Farcaster connect through their own SDKs and never touch
  // wagmi, and Base App is connected by an explicit connect() call.
  //
  // `ssr` stays true: it governs how wagmi hydrates on the server, and turning it off would
  // reintroduce hydration mismatches. With no storage there is simply no state to hydrate FROM.
  storage: null,
  ssr: true,
  transports: {
    // ⚡ TRANSPORTS ORDERED TO MATCH THE CHAINS ARRAY
    [base.id]: transportFor(base.id),
    [baseSepolia.id]: transportFor(baseSepolia.id),
    [celo.id]: transportFor(celo.id),
    [celoAlfajores.id]: transportFor(celoAlfajores.id),
  },
});
