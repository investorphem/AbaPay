import { describe, it, expect } from 'vitest';
import {
  probeProvider,
  probeInjectedConnectors,
  isUserRejection,
  looksLikeValora,
  walletConnectPeerName,
  connectedWalletIsValora,
  walletApprovedChainIds,
  walletConnectSessionLive,
} from '@/lib/walletEnv';

/**
 * These cover the reason a real web3 browser was being shown a WalletConnect QR code for a
 * wallet installed in that same browser.
 *
 * The old probe only ever looked at `window.ethereum`. Under EIP-6963 a wallet announces
 * itself over an event instead of claiming that global, so a browser with a perfectly good
 * wallet reads as "no wallet" — the injected path gets skipped and auto-connect never fires.
 * The fix is to ask each connector wagmi discovered for its own provider.
 */

/** An EIP-1193 stub. `accounts` non-empty = this site is already approved. */
function fakeProvider(accounts: string[] = []) {
  return { request: async ({ method }: { method: string }) => (method === 'eth_accounts' ? accounts : null) };
}

/** A provider that accepts the call and never answers — the stub-extension case. */
function hangingProvider() {
  return { request: () => new Promise(() => {}) };
}

function fakeConnector(id: string, provider: unknown, name = id) {
  return { id, uid: `uid-${id}`, name, type: 'injected', getProvider: async () => provider };
}

/**
 * A cancelled wallet prompt used to be treated as "that route didn't work, try the next one":
 * cancelling an injected connect dropped the user into WalletConnect — a QR they never asked
 * for, and on a network that filters the relay, a socket that never opens. Indistinguishable
 * from the app ignoring the cancel and hanging, which is how it was reported.
 *
 * Each layer of the stack (viem → wagmi → thirdweb) re-wraps the error, so 4001 shows up at a
 * different depth every time. These pin down that it is still found.
 */
describe('isUserRejection', () => {
  it('detects the standard EIP-1193 rejection code at the top level', () => {
    expect(isUserRejection({ code: 4001, message: 'User rejected the request.' })).toBe(true);
  });

  it('finds the code however deep the wrappers bury it', () => {
    expect(isUserRejection({ message: 'Connection request reset', cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection({ cause: { cause: { code: 4001 } } })).toBe(true);
    expect(isUserRejection({ cause: { cause: { cause: { data: { code: 4001 } } } } })).toBe(true);
  });

  it('accepts ethers-style ACTION_REJECTED', () => {
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true);
  });

  it('falls back to the message when no code survived the wrapping', () => {
    for (const message of [
      'User rejected the request.',
      'User denied transaction signature',
      'MetaMask Tx Signature: User denied transaction signature.',
      'The user cancelled the request',
      'Request rejected',
    ]) {
      expect(isUserRejection({ message })).toBe(true);
    }
  });

  it('reads viem\'s shortMessage as well as message', () => {
    expect(isUserRejection({ shortMessage: 'User rejected the request.', message: 'Details…' })).toBe(true);
  });

  // 🔴 The important negatives. Calling one of these a "cancel" would silently swallow a real
  // failure — the user would be told they cancelled something they never saw.
  it('does NOT treat real failures as cancellations', () => {
    expect(isUserRejection({ message: 'insufficient funds for gas' })).toBe(false);
    expect(isUserRejection({ message: 'execution reverted' })).toBe(false);
    expect(isUserRejection({ code: -32603, message: 'Internal JSON-RPC error' })).toBe(false);
    expect(isUserRejection({ message: 'Connection request reset' })).toBe(false);
    expect(isUserRejection(new Error("Your wallet didn't respond in time."))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });

  // A self-referencing cause would otherwise spin forever inside the click handler.
  it('terminates on a circular cause chain', () => {
    const err: any = { message: 'boom' };
    err.cause = err;
    expect(isUserRejection(err)).toBe(false);
  });
});

/**
 * Inside Valora's in-app browser the page can see something that answers `eth_accounts` — real
 * enough for auto-connect to fire and for the whole UI to look connected, not real enough to
 * pay with. The first request raises a prompt, the user taps Allow, Valora toasts "Connection
 * to AbaPay was successful!" — it took a payment authorization for a connection handshake — and
 * returns nothing to the page. Nothing rejects, so there is nothing to catch: the spinner runs
 * forever. Recognising the host is what lets the app skip that rail and use WalletConnect,
 * which Valora actually supports.
 *
 * A false positive costs a real user their in-browser wallet, so the match is deliberately
 * narrow: Valora's own flag, or its name as a whole word in the user agent.
 */
describe('looksLikeValora', () => {
  const VALORA_UA =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Valora/1.100.0';
  const CHROME_UA =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

  it('recognises the in-app browser by its user agent', () => {
    expect(looksLikeValora(VALORA_UA, undefined)).toBe(true);
  });

  it('recognises the flag Valora sets on the injected object', () => {
    expect(looksLikeValora(CHROME_UA, { isValora: true })).toBe(true);
    expect(looksLikeValora(undefined, { isValoraApp: true })).toBe(true);
  });

  // 🔴 The whole point: a wallet that DOES return signatures must keep the injected path.
  it('leaves a working in-browser wallet alone', () => {
    expect(looksLikeValora(CHROME_UA, { isMetaMask: true })).toBe(false);
    expect(looksLikeValora(CHROME_UA, { isZerion: true })).toBe(false);
    expect(looksLikeValora(CHROME_UA, { isMiniPay: true })).toBe(false);
    expect(looksLikeValora(CHROME_UA, undefined)).toBe(false);
    expect(looksLikeValora(undefined, undefined)).toBe(false);
  });

  // Word-bounded so an unrelated token can't strip a user's wallet off the injected path.
  it('does not match on a substring inside another token', () => {
    expect(looksLikeValora(`${CHROME_UA} Valorant/2.0`, undefined)).toBe(false);
    expect(looksLikeValora(`${CHROME_UA} EvaloraX/1.0`, undefined)).toBe(false);
  });

  // A falsy flag is not a claim. Only `true` counts.
  it('ignores a flag that is present but not true', () => {
    expect(looksLikeValora(CHROME_UA, { isValora: false })).toBe(false);
    expect(looksLikeValora(CHROME_UA, { isValora: undefined })).toBe(false);
  });
});

/**
 * 🔴 WHY PEER METADATA AND NOT THE PAGE'S OWN GLOBALS. Identifying Valora from `isValora` or the
 * user agent does not work in its in-app browser: it injects no provider and its webview reports
 * a stock Android Chrome user agent, so the page has nothing local to go on. The session is the
 * only thing that names the wallet — WalletConnect exchanges peer metadata on connect.
 *
 * The trade-off is that this is only knowable AFTER connecting, so it shapes what happens next
 * rather than pre-empting the connection.
 */
describe('walletConnectPeerName / connectedWalletIsValora', () => {
  const wc = (name?: string) => ({
    type: 'walletConnect',
    id: 'walletConnect',
    getProvider: async () => ({ session: name === undefined ? {} : { peer: { metadata: { name } } } }),
  });

  it('reads the wallet name the peer reports for itself', async () => {
    expect(await walletConnectPeerName(wc('Valora'))).toBe('Valora');
    expect(await walletConnectPeerName(wc('MetaMask'))).toBe('MetaMask');
  });

  it('identifies Valora regardless of casing or surrounding words', async () => {
    expect(await connectedWalletIsValora(wc('Valora'))).toBe(true);
    expect(await connectedWalletIsValora(wc('valora'))).toBe(true);
    expect(await connectedWalletIsValora(wc('Valora Wallet'))).toBe(true);
  });

  // 🔴 A false positive drops a working session and forces a needless re-pair.
  it('leaves every other wallet connected', async () => {
    expect(await connectedWalletIsValora(wc('MetaMask'))).toBe(false);
    expect(await connectedWalletIsValora(wc('Trust Wallet'))).toBe(false);
    expect(await connectedWalletIsValora(wc('Valorant Wallet'))).toBe(false); // word-bounded
    expect(await connectedWalletIsValora(wc(undefined))).toBe(false);
  });

  it('returns null for connectors that have no peer at all', async () => {
    expect(await walletConnectPeerName({ type: 'injected', id: 'io.metamask' })).toBeNull();
    expect(await walletConnectPeerName(undefined)).toBeNull();
    expect(await connectedWalletIsValora({ type: 'injected' })).toBe(false);
  });

  it('treats a blank name as unknown rather than as a match', async () => {
    expect(await walletConnectPeerName(wc('   '))).toBeNull();
    expect(await connectedWalletIsValora(wc('   '))).toBe(false);
  });

  it('returns null rather than throwing when the provider errors', async () => {
    expect(await walletConnectPeerName({
      type: 'walletConnect',
      getProvider: async () => { throw new Error('nope'); },
    })).toBeNull();
  });
});

/**
 * A WalletConnect wallet silently DROPS requests for a chain outside its approved session — no
 * prompt, no error, nothing back over the relay. Valora is Celo-only, and wagmi asks for
 * chains[0], which became Base when Base became the default: the session looked healthy, the
 * address populated, balances rendered off a public RPC, and then every transaction vanished.
 *
 * Reading the session's own chain list is how the app tells "connected on a chain this wallet
 * supports" from "connected, having optimistically named one it does not".
 */
describe('walletApprovedChainIds', () => {
  const withSession = (chains: unknown) => ({
    getProvider: async () => ({ session: { namespaces: { eip155: { chains } } } }),
  });

  it('parses CAIP-2 chain ids from a WalletConnect session', async () => {
    expect(await walletApprovedChainIds(withSession(['eip155:42220', 'eip155:8453']))).toEqual([42220, 8453]);
  });

  it('reports Celo-only for a Valora-shaped session — the case that was hanging', async () => {
    const approved = await walletApprovedChainIds(withSession(['eip155:42220']));
    expect(approved).toEqual([42220]);
    expect(approved).not.toContain(8453); // Base — requests for it would be dropped
  });

  // 🔴 null means "unknowable", and callers must read it as "no constraint". Returning [] here
  // would read as "supports nothing" and would strand every injected wallet on a false error.
  it('returns null when there is no session to read', async () => {
    expect(await walletApprovedChainIds({ getProvider: async () => ({}) })).toBeNull();
    expect(await walletApprovedChainIds({ getProvider: async () => null })).toBeNull();
    expect(await walletApprovedChainIds(undefined)).toBeNull();
  });

  it('returns null rather than throwing when the provider errors', async () => {
    expect(await walletApprovedChainIds({ getProvider: async () => { throw new Error('nope'); } })).toBeNull();
  });

  it('returns null for an empty or unparseable chain list', async () => {
    expect(await walletApprovedChainIds(withSession([]))).toBeNull();
    expect(await walletApprovedChainIds(withSession('not-an-array'))).toBeNull();
    expect(await walletApprovedChainIds(withSession(['solana:xyz']))).toBeNull();
  });
});

/**
 * The "auto-connects, then hangs forever" failure. wagmi persists the WalletConnect session and
 * restores it on load, which produces an address — and an address is all the UI needs to look
 * connected, since balances come from a public RPC and never touch the wallet. But a request
 * only reaches the phone if the RELAY SOCKET is open. Restored over a dead socket, the
 * transaction is written to a closed pipe: no prompt, nothing back, and nothing to catch,
 * because nothing rejected.
 */
describe('walletConnectSessionLive', () => {
  const wc = (provider: any) => ({ type: 'walletConnect', id: 'walletConnect', getProvider: async () => provider });

  it('is live when a session exists and the relay socket is connected', async () => {
    expect(await walletConnectSessionLive(wc({ session: {}, client: { core: { relayer: { connected: true } } } }))).toBe(true);
  });

  it('is DEAD when the session was restored but the relay socket is closed — the hang', async () => {
    expect(await walletConnectSessionLive(wc({ session: {}, client: { core: { relayer: { connected: false } } } }))).toBe(false);
  });

  it('reads the socket state off the signer client too', async () => {
    expect(await walletConnectSessionLive(wc({ session: {}, signer: { client: { core: { relayer: { connected: false } } } } }))).toBe(false);
  });

  it('is dead when nothing was restored at all', async () => {
    expect(await walletConnectSessionLive(wc({}))).toBe(false);
    expect(await walletConnectSessionLive(wc(null))).toBe(false);
  });

  // 🔴 A missing internal is not evidence of a dead socket. Treating it as dead would
  // disconnect working wallets on every payment.
  it('assumes live when the socket state cannot be read', async () => {
    expect(await walletConnectSessionLive(wc({ session: {} }))).toBe(true);
  });

  // null = "not applicable", and the caller must not read it as a failure.
  it('returns null for non-WalletConnect connectors, which have no socket to lose', async () => {
    expect(await walletConnectSessionLive({ type: 'injected', id: 'io.metamask' })).toBeNull();
    expect(await walletConnectSessionLive({ type: 'baseAccount', id: 'baseAccount' })).toBeNull();
    expect(await walletConnectSessionLive(undefined)).toBeNull();
  });

  it('returns null rather than throwing when the provider errors', async () => {
    expect(await walletConnectSessionLive({ type: 'walletConnect', getProvider: async () => { throw new Error('x'); } })).toBeNull();
  });
});

describe('probeProvider', () => {
  it('reports authorized when the wallet already has accounts for this site', async () => {
    expect(await probeProvider(fakeProvider(['0xabc']))).toEqual({ status: 'authorized', accounts: ['0xabc'] });
  });

  it('reports available when a real wallet answers but has not approved this site', async () => {
    expect(await probeProvider(fakeProvider([]))).toEqual({ status: 'available' });
  });

  it('reports none when there is no provider at all', async () => {
    expect(await probeProvider(null)).toEqual({ status: 'none' });
    expect(await probeProvider(undefined)).toEqual({ status: 'none' });
    expect(await probeProvider({})).toEqual({ status: 'none' });
  });

  // The whole reason the probe is timed out: a stub that never settles must not hang the
  // connect flow forever, which is the original "Connect does nothing" bug.
  it('reports none when the provider never answers, rather than hanging', async () => {
    expect(await probeProvider(hangingProvider(), 40)).toEqual({ status: 'none' });
  });

  it('reports none when the provider throws', async () => {
    expect(await probeProvider({ request: async () => { throw new Error('nope'); } })).toEqual({ status: 'none' });
  });
});

describe('probeInjectedConnectors', () => {
  it('finds an EIP-6963 wallet that never claimed window.ethereum — the reported bug', async () => {
    const found = await probeInjectedConnectors([fakeConnector('io.metamask', fakeProvider(['0xabc']), 'MetaMask')]);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('MetaMask');
    expect(found[0].status).toBe('authorized');
  });

  it('ignores connectors that are not injected rails', async () => {
    const found = await probeInjectedConnectors([
      { id: 'walletConnect', type: 'walletConnect', name: 'WalletConnect', getProvider: async () => fakeProvider(['0xabc']) },
      { id: 'baseAccount', type: 'baseAccount', name: 'Base Account', getProvider: async () => fakeProvider(['0xabc']) },
    ]);
    expect(found).toEqual([]);
  });

  // 🔴 The dedupe that keeps "exactly one wallet" from becoming a needless chooser: one
  // extension parked on window.ethereum AND announced over EIP-6963 is listed twice by wagmi.
  it('collapses the same wallet appearing as both a named and a generic connector', async () => {
    const found = await probeInjectedConnectors([
      fakeConnector('io.metamask', fakeProvider(['0xabc']), 'MetaMask'),
      fakeConnector('injected', fakeProvider(['0xabc']), 'Injected'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('MetaMask');
  });

  it('keeps every DISTINCT wallet, so the chooser can offer a real choice', async () => {
    const found = await probeInjectedConnectors([
      fakeConnector('io.metamask', fakeProvider(['0xabc']), 'MetaMask'),
      fakeConnector('io.rabby', fakeProvider([]), 'Rabby'),
    ]);
    expect(found.map((c) => c.name).sort()).toEqual(['MetaMask', 'Rabby']);
    expect(found.find((c) => c.name === 'MetaMask')?.status).toBe('authorized');
    expect(found.find((c) => c.name === 'Rabby')?.status).toBe('available');
  });

  it('falls back to the generic connector when no EIP-6963 wallet announced itself', async () => {
    const found = await probeInjectedConnectors([fakeConnector('injected', fakeProvider(['0xabc']), 'Injected')]);
    expect(found).toHaveLength(1);
    expect(found[0].connector.id).toBe('injected');
  });

  // A wedged wallet is reported as 'none' rather than dropped, so the caller can tell
  // "no wallets in this browser" apart from "a wallet that isn't answering".
  it('keeps a non-answering wallet in the list, marked none', async () => {
    const found = await probeInjectedConnectors([fakeConnector('io.broken', hangingProvider(), 'Broken')], 40);
    expect(found).toHaveLength(1);
    expect(found[0].status).toBe('none');
  });

  it('returns nothing when the browser has no wallet at all — the WalletConnect case', async () => {
    expect(await probeInjectedConnectors([])).toEqual([]);
  });
});
