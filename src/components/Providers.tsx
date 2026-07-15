"use client";

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { ThirdwebProvider } from 'thirdweb/react';
import { config } from '../config/wagmi';
import { useState } from 'react';

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {/* ⚡ Powers x402 settlement in the main app only (src/app/page.tsx processX402Payment).
             The user's wagmi-connected wallet is synced into this as the "active wallet" —
             see the effect near the wagmiWalletClient sync in page.tsx. No second wallet connect. */}
        <ThirdwebProvider>
          {children}
        </ThirdwebProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
