import { http, createConfig, createStorage, cookieStorage } from 'wagmi';
import { base, baseSepolia, celo, celoAlfajores } from 'wagmi/chains';
import { baseAccount, injected } from 'wagmi/connectors';

export const config = createConfig({
  chains: [base, baseSepolia, celo, celoAlfajores],
  connectors: [
    injected(),
    baseAccount({
      appName: 'AbaPay',
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
