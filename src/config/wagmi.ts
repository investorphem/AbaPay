import { http, createConfig, createStorage, cookieStorage } from 'wagmi';
import { base, baseSepolia, celo, celoAlfajores } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors'; // ⚡ IMPORTED walletConnect

// ⚡ PULL IN YOUR WALLETCONNECT ID
// Temporarily hardcoded for the test!
const projectId = "2fe5da1f6c2f9fdac04aba0ba8023015"; 

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
