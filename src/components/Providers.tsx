"use client";

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { config } from '../config/wagmi';
import { useState } from 'react';

// ⚡ ONE WALLET STACK, DELIBERATELY.
//
// This used to also mount ThirdwebProvider, because x402 settlement signed through thirdweb's
// wallet — a second connection living beside the wagmi one, which had to establish itself before
// it could sign and surfaced over WalletConnect as an extra connection prompt mid-payment.
// x402 now signs with the app's own wagmi/viem wallet client (src/lib/x402Pay.ts), so there is
// nothing left for a second provider to do.
export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
