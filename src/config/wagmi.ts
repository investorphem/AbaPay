import { http, createConfig, createStorage, cookieStorage } from 'wagmi';
import { base, baseSepolia, celo, celoAlfajores } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors';

// ⚡ PULL IN YOUR WALLETCONNECT ID
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

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
      // ⚡ VALORA INTEGRATION: Forces Valor
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
    [celo.id]: http(),
    [celoAlfajores.id]: http(),
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});