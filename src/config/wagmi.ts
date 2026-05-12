import { http, createConfig, createStorage, cookieStorage } from 'wagmi';
import { base, baseSepolia, celo, celoAlfajores } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors'; // ⚡ IMPORTED walletConnect

// ⚡ PULL IN YOUR WALLETCONNECT ID
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

export const config = createConfig({
  chains: [base, baseSepolia, celo, celoAlfajores],
  connectors: [
    injected(),
    baseAccount({
      appName: 'AbaPay',
    }),
    // ⚡ THE NEW WALLETCONNECT BRIDGE FOR VALORA & MOBILE WALLETS
    walletConnect({ 
      projectId, 
      showQrModal: true,
      metadata: {
        name: 'AbaPay',
        description: 'Seamless Crypto Bill Payments',
        // ⚡ DYNAMIC URL: Uses localhost when testing, abapays.com when live
        url: typeof window !== 'undefined' ? window.location.origin : 'https://abapays.com', 
        icons: ['https://abapays.com/logo.png'] 
      }
    }),
  ],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
    [celo.id]: http(),
    [celoAlfajores.id]: http(),
  },
});
