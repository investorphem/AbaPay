import { describe, it, expect } from 'vitest';
import { probeProvider, probeInjectedConnectors } from '@/lib/walletEnv';

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
