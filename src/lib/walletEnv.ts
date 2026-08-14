// ⚡ WALLET CONNECTION ENVIRONMENT
//
// Everything here exists because of one class of failure: the Connect button doing nothing
// at all. Two independent causes were found in production, and both presented identically
// to the user (silence):
//
//   1. A STUB `window.ethereum`. Several browser extensions (and some in-app webviews)
//      define `window.ethereum` without being a usable wallet — no identity flag, no
//      EIP-6963 announcement, and a `request()` that never settles. The old check was
//      `Boolean(window.ethereum)`, so those users were routed down the injected path and
//      hung forever, never reaching the WalletConnect fallback that would have worked.
//
//   2. A FILTERED WALLETCONNECT RELAY. Some Nigerian mobile networks (MTN most reported)
//      block `relay.walletconnect.org`. It's a WebSocket, so it fails silently — no error
//      to catch, just a promise that never resolves.
//
// The cure for both is the same shape: never trust a connector to settle, always race it
// against a timeout, and always tell the user which dependency actually failed.

/**
 * Is `window.ethereum` a wallet we should actually attempt, or a stub left by an extension?
 *
 * A genuine injected wallet advertises itself: MetaMask sets `isMetaMask`, MiniPay sets
 * `isMiniPay`, Valora/Trust/Rabby etc. all set their own `is*` flag, and multi-wallet
 * browsers expose a `providers` array. A provider with a `request()` but NO identity at all
 * is not something we should hand the user's connection attempt to — falling through to
 * WalletConnect gives them a working path instead of a dead one.
 */
export function looksLikeRealInjectedWallet(): boolean {
  if (typeof window === 'undefined') return false;
  const eth = (window as any).ethereum;
  if (!eth || typeof eth.request !== 'function') return false;

  if (Array.isArray(eth.providers) && eth.providers.length > 0) return true;

  return Object.keys(eth).some((k) => k.startsWith('is') && eth[k] === true);
}

/** True when we're inside MiniPay's browser — the one path that touches no blockable host. */
export function isMiniPayBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).ethereum?.isMiniPay);
}

// An injected wallet shows its own approval UI, so the user needs real time to react. This
// is a backstop against a wedged provider, NOT a limit on how long someone may take to
// approve — hence minutes, not seconds.
export const INJECTED_CONNECT_TIMEOUT_MS = 180_000;

// ⚠️ DO NOT put a timeout on the WalletConnect connect() promise itself. It does not resolve
// when the relay connects — it resolves when the user has scanned the QR and approved in
// their wallet, which legitimately takes minutes. Timing that out would break every normal
// WalletConnect connection.
//
// What we time out instead is the RELAY HANDSHAKE, observed via the `display_uri` event:
// the connector emits it once it has a pairing URI, which requires the relay socket to be
// open. URI within the window = the relay is fine, and from there we wait on the user as
// long as they need. No URI = the relay is unreachable (the MTN case), and that is worth
// telling the user about immediately.
export const RELAY_HANDSHAKE_TIMEOUT_MS = 12_000;

/**
 * Resolves true once the connector emits a WalletConnect pairing URI (relay reachable),
 * false if none arrives in time (relay filtered or down).
 */
export function waitForRelayHandshake(connector: any, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const emitter = connector?.emitter;
    if (!emitter?.on) {
      // Can't observe it — don't block the connection on our inability to watch.
      resolve(true);
      return;
    }

    const finish = (result: boolean) => {
      clearTimeout(timer);
      try { emitter.off?.('message', onMessage); } catch { /* already detached */ }
      resolve(result);
    };

    const onMessage = (message: any) => {
      if (message?.type === 'display_uri') finish(true);
    };

    const timer = setTimeout(() => finish(false), ms);
    emitter.on('message', onMessage);
  });
}

export class ConnectTimeoutError extends Error {
  constructor(public readonly stage: 'injected' | 'walletconnect') {
    super(`Connection timed out during: ${stage}`);
    this.name = 'ConnectTimeoutError';
  }
}

/** Raised when the relay never produced a pairing URI — the signature of a filtered relay. */
export class RelayUnreachableError extends Error {
  constructor() {
    super('WalletConnect relay did not respond');
    this.name = 'RelayUnreachableError';
  }
}

/** Race a connector against the clock so a never-settling provider can't hang the UI. */
export function withConnectTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage: 'injected' | 'walletconnect',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectTimeoutError(stage)), ms);
    }),
  ]);
}

/**
 * Turn a connector failure into something a user can act on. The MTN case is called out by
 * name because it is by far the most common cause of a timed-out relay for our users, and
 * "try MiniPay" is a fix they can apply in the next thirty seconds.
 */
export function describeConnectFailure(error: unknown): string {
  if (error instanceof RelayUnreachableError ||
      (error instanceof ConnectTimeoutError && error.stage === 'walletconnect')) {
    return "Couldn't reach the wallet connection service. Some Nigerian networks (MTN especially) block it — try another network or a VPN, or open AbaPay inside MiniPay, which doesn't need it.";
  }

  if (error instanceof ConnectTimeoutError) {
    return "Your wallet didn't respond. Open your wallet app or extension and try again, or use the WalletConnect option.";
  }

  const message = String((error as any)?.message || error || '');

  if (/rejected|denied|user cancel/i.test(message)) {
    return 'Connection request was cancelled.';
  }
  if (/reset|Connection request reset/i.test(message)) {
    return 'Connection was closed before it finished. Tap Connect to try again.';
  }
  if (/appkit|modal/i.test(message)) {
    return "The wallet chooser couldn't load. Check your connection and try again.";
  }

  return message
    ? `Couldn't connect: ${message}`
    : "Couldn't connect to a wallet. Please try again.";
}

/**
 * Every third-party host the connect + payment path depends on. Used by /network-check so a
 * user on a filtered network can tell us exactly WHICH host their carrier blocks — which is
 * also the list to quote in a complaint to the carrier or the NCC.
 */
export const CONNECT_DEPENDENCY_HOSTS: Array<{
  label: string;
  url: string;
  kind: 'websocket' | 'http';
  why: string;
  critical: boolean;
}> = [
  {
    label: 'WalletConnect relay',
    url: process.env.NEXT_PUBLIC_WC_RELAY_URL || 'wss://relay.walletconnect.org',
    kind: 'websocket',
    why: 'Carries every WalletConnect session. Valora and most mobile wallets need it.',
    critical: true,
  },
  {
    label: 'WalletConnect wallet list',
    url: 'https://api.web3modal.org',
    kind: 'http',
    why: 'Renders the wallet chooser. Blocked = the QR screen never appears.',
    critical: true,
  },
  {
    label: 'Celo RPC (forno)',
    url: 'https://forno.celo.org',
    kind: 'http',
    why: 'Reads your Celo balance and allowance.',
    critical: true,
  },
  {
    label: 'Base RPC',
    url: 'https://mainnet.base.org',
    kind: 'http',
    why: 'Reads your Base balance and allowance.',
    critical: true,
  },
  {
    label: 'Coinbase keys (Base Account)',
    url: 'https://keys.coinbase.com',
    kind: 'http',
    why: 'Only needed for the Base Account sign-in option.',
    critical: false,
  },
  {
    label: 'Coinbase analytics',
    url: 'https://cca-lite.coinbase.com',
    kind: 'http',
    why: 'Telemetry only — blocking it costs you nothing.',
    critical: false,
  },
];
