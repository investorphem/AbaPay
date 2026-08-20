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
    // ⚡ reconnectOnMount={false} — THE CONNECT BUTTON IS THE ONLY WAY IN ON THE WEB.
    //
    // 🔴 THIS IS THE AUTO-CONNECT NOBODY COULD FIND. wagmi persists the connector to storage and,
    // with the default `reconnectOnMount`, silently re-establishes it on EVERY page load. That
    // happens inside WagmiProvider, before any effect in page.tsx runs and regardless of what
    // those effects decide — so the app came up connected on its own no matter how carefully the
    // auto-connect rules downstream were written, and every attempt to fix it by editing them
    // was editing the wrong thing.
    //
    // Off, so a web user connects when they press Connect and not before, and the wallet chooser
    // (every detected injected wallet, plus WalletConnect) is actually reachable.
    //
    // ⚠️ THE TRADE, STATED PLAINLY: a refresh now ends the session and the user presses Connect
    // again. That is the intended behaviour — being asked is the point — but it IS a real cost
    // on a page people reload.
    //
    // The three surfaces where silent connect is right are untouched: MiniPay and Farcaster
    // never come through wagmi at all (their own SDKs connect them in page.tsx's environment
    // detector), and Base App is connected by an explicit connect() once its provider confirms
    // this site is already authorised. See AUTO_CONNECT_SURFACES in src/lib/walletEnv.ts.
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
