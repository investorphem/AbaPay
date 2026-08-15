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
//   2. A FILTERED WALLETCONNECT RELAY. Some networks block `relay.walletconnect.org`.
//      It's a WebSocket, so it fails silently — no error to catch, just a promise that
//      never resolves. Confirmed on at least one carrier (works over VPN, fails without);
//      we have no data on how widespread it is, so nothing user-facing names a network.
//
// The cure for both is the same shape: never trust a connector to settle, always race it
// against a timeout, and always tell the user which dependency actually failed.

/**
 * What the injected provider actually is, established by ASKING it rather than by sniffing
 * flags on it.
 *
 *  • `authorized` — it already has accounts for this site. We can connect with no click and
 *    no prompt: the user is in a wallet's in-app browser (MiniPay, Valora, Base App, Trust,
 *    MetaMask mobile), or they connected here before in a normal browser.
 *  • `available`  — a real provider that answered, but this site isn't approved yet. Do NOT
 *    auto-connect (that would fire an unsolicited permission popup on page load); show the
 *    Connect button and use this provider when it's clicked.
 *  • `none`       — no provider, or a stub that never answered. The Connect button should
 *    skip the injected path entirely and go straight to WalletConnect.
 */
export type InjectedProbe =
  | { status: 'authorized'; accounts: string[] }
  | { status: 'available' }
  | { status: 'none' };

export const INJECTED_PROBE_TIMEOUT_MS = 3_000;

/**
 * Silently ask the injected provider whether it already has accounts for this site.
 *
 * `eth_accounts` NEVER prompts — it returns [] when the site isn't authorized. That is what
 * makes auto-connect safe to run on every page load, and it's the same technique the
 * Farcaster path already uses (getAddresses()). Contrast `eth_requestAccounts`, which is
 * what wagmi's connect() calls and which DOES prompt.
 *
 * The timeout is what makes this safe against stub providers: one that never answers
 * resolves to `none` after a few seconds instead of hanging the flow forever.
 */
export async function probeInjectedProvider(
  timeoutMs: number = INJECTED_PROBE_TIMEOUT_MS,
): Promise<InjectedProbe> {
  if (typeof window === 'undefined') return { status: 'none' };
  return probeProvider((window as any).ethereum, timeoutMs);
}

/**
 * The same probe, against ANY EIP-1193 provider rather than `window.ethereum` specifically.
 *
 * 🔴 THE BUG THIS EXISTS FOR: probing only `window.ethereum` is why a real web3 browser fell
 * through to WalletConnect. Under **EIP-6963** a wallet announces itself over an event instead
 * of claiming the `window.ethereum` global — which is how modern extensions coexist without
 * fighting over one slot — so a browser with a perfectly good wallet can have `window.ethereum`
 * undefined, or pointing at a different wallet than the one the user means. The old probe read
 * `none` there, the injected path was skipped entirely, and the user was shown a QR code for a
 * wallet sitting right there in the same browser. Auto-connect died for the same reason.
 *
 * wagmi already discovers those wallets (`multiInjectedProviderDiscovery` defaults to true) and
 * exposes one connector per wallet; this lets us ask each of them the same silent question.
 */
export async function probeProvider(
  provider: any,
  timeoutMs: number = INJECTED_PROBE_TIMEOUT_MS,
): Promise<InjectedProbe> {
  if (!provider || typeof provider.request !== 'function') return { status: 'none' };

  let timer: ReturnType<typeof setTimeout>;
  try {
    const accounts = (await Promise.race([
      Promise.resolve(provider.request({ method: 'eth_accounts' })).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('injected probe timed out')), timeoutMs);
      }),
    ])) as unknown;

    if (Array.isArray(accounts) && accounts.length > 0) {
      return { status: 'authorized', accounts: accounts as string[] };
    }
    return { status: 'available' };
  } catch {
    // Threw or never answered — treat as no usable injected wallet.
    return { status: 'none' };
  }
}

/**
 * Did the USER decline, as opposed to something going wrong?
 *
 * 🔴 THE FAILURE THIS EXISTS FOR: a cancelled wallet prompt was being treated as "that route
 * didn't work, try the next one". Cancelling an injected connect dropped the user into the
 * WalletConnect branch — a QR code they never asked for, and on a network that filters the
 * relay, a socket that never opens. From the outside that is indistinguishable from the app
 * ignoring the cancel and hanging forever, which is precisely how it was reported.
 *
 * A rejection is an ANSWER. It must end the attempt immediately and say so, never silently
 * retry on another rail — the same rule that stops a declined payment raising a second prompt.
 *
 * EIP-1193 standardises 4001 for this and every wallet sets it, but each layer of the stack
 * (viem wraps, wagmi wraps, thirdweb wraps again) buries it at a different depth, so the cause
 * chain is walked and the message checked as a backstop.
 */
export function isUserRejection(e: any): boolean {
  for (let node = e, depth = 0; node && depth < 6; node = node.cause, depth++) {
    const code = node.code ?? node.data?.code;
    if (code === 4001 || code === 'ACTION_REJECTED') return true;
  }
  const message = String(e?.shortMessage || e?.message || '').toLowerCase();
  return /user rejected|user denied|user cancell?ed|rejected the request|request rejected|denied transaction|denied message|cancell?ed by user/.test(
    message,
  );
}

/** One injected wallet wagmi found, plus what it answered when asked about this site. */
export interface InjectedCandidate {
  /** wagmi connector — `id` is the EIP-6963 rdns ('io.metamask'), or 'injected' for the generic one. */
  connector: any;
  name: string;
  icon?: string;
  status: InjectedProbe['status'];
}

/**
 * Every injected wallet reachable in THIS browser, each asked (silently) whether it already
 * has accounts for this site.
 *
 * Deliberately probes each connector's own provider rather than the `window.ethereum` global,
 * so an EIP-6963 wallet is found even when it never claimed that global — see probeProvider.
 * A connector whose provider doesn't answer is reported as `none` rather than dropped, so the
 * caller can tell "no wallets here" apart from "a wallet that is wedged".
 */
export async function probeInjectedConnectors(
  connectors: readonly any[],
  timeoutMs: number = INJECTED_PROBE_TIMEOUT_MS,
): Promise<InjectedCandidate[]> {
  // EIP-6963-discovered connectors and the generic injected() connector both report
  // type 'injected'. Everything else (walletConnect, baseAccount) is a different rail.
  const injected = connectors.filter((c) => c?.type === 'injected');

  const probed = await Promise.all(
    injected.map(async (connector): Promise<InjectedCandidate> => {
      let provider: any = null;
      try {
        provider = await connector.getProvider?.();
      } catch {
        // A connector that can't even hand over its provider is not usable.
      }
      const probe = await probeProvider(provider, timeoutMs);
      return {
        connector,
        name: connector.name || 'Browser wallet',
        icon: connector.icon,
        status: probe.status,
      };
    }),
  );

  // 🔴 DEDUPE. When a single extension is both EIP-6963-announced AND parked on
  // window.ethereum, wagmi lists it twice — once as 'io.metamask', once as the generic
  // 'injected'. Showing the same wallet twice in a chooser looks broken, and worse, it would
  // turn the "exactly one wallet, connect it directly" case into a needless chooser. The
  // named EIP-6963 entry wins; the generic one is only kept when nothing else was found.
  const named = probed.filter((c) => c.connector.id !== 'injected');
  const generic = probed.filter((c) => c.connector.id === 'injected');
  return named.length > 0 ? named : generic;
}

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

/** True when we're inside MiniPay's browser — one of the paths that touches no blockable host. */
export function isMiniPayBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).ethereum?.isMiniPay);
}

/**
 * The hosts that connect a wallet WITHOUT touching the WalletConnect relay: MiniPay and Base
 * App inject a provider straight into the page, and Farcaster supplies its own wallet through
 * the Mini App SDK. On a network that filters the relay, these keep working — which is why
 * every failure message points at them.
 */
export const RELAY_FREE_SURFACES = ['MiniPay', 'Base App', 'Farcaster'] as const;

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
// long as they need. No URI = the relay is unreachable (the blocked-network case), and that
// is worth telling the user about immediately.
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
 * Turn a connector failure into something a user can act on.
 *
 * ⚠️ Deliberately names NO country and NO carrier. We have confirmed the block exists on at
 * least one network, but we have no evidence about which other networks or regions are
 * affected — and naming a specific carrier to someone who is not on it makes them distrust
 * the whole message. Describe what we actually know ("your network is blocking it") and
 * give them routes out.
 */
export function describeConnectFailure(error: unknown): string {
  if (error instanceof RelayUnreachableError ||
      (error instanceof ConnectTimeoutError && error.stage === 'walletconnect')) {
    return "Your network is blocking the service AbaPay uses to connect external wallets. Try a different network or a VPN — or open AbaPay in MiniPay, Base App or Farcaster, which connect your wallet directly and aren't affected.";
  }

  if (error instanceof ConnectTimeoutError) {
    return "Your wallet didn't respond. Open your wallet app or extension and try again, or use the WalletConnect option.";
  }

  // Checked BEFORE the message patterns below, because a wrapped rejection often carries a
  // generic outer message ("Connection request reset") with the 4001 buried in its cause —
  // which used to be reported as a mysterious failure instead of "you cancelled this".
  if (isUserRejection(error)) {
    return 'Connection request was cancelled.';
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
