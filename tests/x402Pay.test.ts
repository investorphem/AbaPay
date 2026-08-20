import { describe, it, expect, vi, afterEach } from 'vitest';
import { payWithX402, parseX402Challenge, X402PaymentError, X402ChallengeError } from '@/lib/x402Pay';

/**
 * The double-charge this file exists to prevent.
 *
 * x402 settlement is atomic, so a FAILED settlement is safe to retry on the contract-call rail —
 * and the app does exactly that. But "the server returned an error" is not the same thing as
 * "nothing moved": /api/pay/x402 answers 400 when a payment SETTLED and then couldn't be turned
 * into a bill (it writes the row and queues a refund first). The old client went through
 * thirdweb's fetch wrapper, which threw a bare Error with no body — so the page couldn't tell
 * those apart and fell back either way, raising a second real payment prompt for a bill the user
 * had already paid. `settled` is that distinction.
 */

const PAY_TO = '0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488';
const ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ACCOUNT = '0xec24bAfBc989a9bE5f6F0eAD8848753B5E4aE0B6' as `0x${string}`;

const accept = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '74627',
  maxAmountRequired: '74627',
  payTo: PAY_TO,
  asset: ASSET,
  maxTimeoutSeconds: 86400,
  extra: { name: 'USD Coin', version: '2', primaryType: 'TransferWithAuthorization' },
};

/** A wallet that signs whatever it's handed, and records what that was. */
function fakeWallet() {
  const calls: any[] = [];
  return {
    calls,
    client: {
      signTypedData: async (args: any) => { calls.push(args); return '0xdeadbeef'; },
    } as any,
  };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('payWithX402', () => {
  it('signs the challenge and returns the vend result on success', async () => {
    const wallet = fakeWallet();
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return seen.length === 1
        ? jsonResponse({ x402Version: 1, error: 'Payment required', accepts: [accept] }, 402)
        : jsonResponse({ success: true, status: 'SUCCESS', tx_hash: '0xabc' }, 200);
    }));

    const result = await payWithX402({ url: '/api/pay/x402', body: { serviceID: 'mtn' }, client: wallet.client, account: ACCOUNT });

    expect(result).toMatchObject({ success: true, tx_hash: '0xabc' });
    // Signed against the challenge's own domain and the payer's account — not app defaults.
    expect(wallet.calls[0].domain).toMatchObject({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET });
    expect(wallet.calls[0].message.to).toBe(PAY_TO);
    expect(wallet.calls[0].message.value).toBe(BigInt('74627'));
    // The retry carries the signature; the first request must not.
    expect((seen[0].headers as any)['X-PAYMENT']).toBeUndefined();
    expect((seen[1].headers as any)['X-PAYMENT']).toBeTruthy();
  });

  it('marks a failure that carries a tx_hash as SETTLED — never safe to retry', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [accept] }, 402)
      : jsonResponse({ success: false, status: 'FAILED_VENDING', message: 'Payment settled, but the request was missing bill details', tx_hash: '0xsettled' }, 400))));

    const err = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT })
      .catch((e) => e);

    expect(err).toBeInstanceOf(X402PaymentError);
    expect(err.settled).toBe(true);
    expect(err.txHash).toBe('0xsettled');
  });

  it('marks a facilitator rejection as NOT settled — the contract call is a safe second attempt', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [accept] }, 402)
      : jsonResponse({ x402Version: 1, error: 'invalid signature', accepts: [accept] }, 402))));

    const err = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT })
      .catch((e) => e);

    expect(err).toBeInstanceOf(X402PaymentError);
    expect(err.settled).toBe(false);
    expect(err.message).toBe('invalid signature');
  });

  it('never prompts for a signature when the wallet is on a different chain than the challenge', async () => {
    const wallet = fakeWallet();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ accepts: [accept] }, 402)));

    await expect(payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT, expectedChainId: 42220 }))
      .rejects.toBeInstanceOf(X402ChallengeError);
    expect(wallet.calls).toHaveLength(0);
  });

  it('passes a 2xx straight back — no payment was required, so nothing is signed', async () => {
    const wallet = fakeWallet();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, status: 'DUPLICATE' }, 200)));

    const result = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });
    expect(result).toMatchObject({ status: 'DUPLICATE' });
    expect(wallet.calls).toHaveLength(0);
  });

  it('uses a fresh nonce per payment, so two bills can never collide on-chain', async () => {
    const wallet = fakeWallet();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) =>
      ((init.headers as any)?.['X-PAYMENT'] ? jsonResponse({ success: true }, 200) : jsonResponse({ accepts: [accept] }, 402))));

    await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });
    await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });

    expect(wallet.calls[0].message.nonce).not.toBe(wallet.calls[1].message.nonce);
  });
});

describe('parseX402Challenge', () => {
  it('reads the v1 challenge from the body', () => {
    const res = new Response(null, { status: 402 });
    expect(parseX402Challenge(res, { accepts: [accept] })).toMatchObject({ payTo: PAY_TO });
  });

  it('falls back to the v2 payment-required header when the body has none', () => {
    const header = btoa(JSON.stringify({ x402Version: 2, accepts: [accept] }));
    const res = new Response(null, { status: 402, headers: { 'payment-required': header } });
    expect(parseX402Challenge(res, {})).toMatchObject({ asset: ASSET });
  });

  it('refuses a challenge with no usable "exact" entry rather than signing something malformed', () => {
    const res = new Response(null, { status: 402 });
    expect(() => parseX402Challenge(res, { accepts: [{ scheme: 'upto', payTo: PAY_TO, asset: ASSET }] })).toThrow(X402ChallengeError);
    expect(() => parseX402Challenge(res, {})).toThrow(X402ChallengeError);
  });
});

describe('payWithX402 — the duplicate guard', () => {
  it('returns a 409 DUPLICATE as data, not as a settlement failure', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [accept] }, 402)
      : jsonResponse({ success: false, status: 'DUPLICATE', message: 'You already paid ₦5,000 to meter 123 today.' }, 409))));

    // Nothing settled (the server checks before it settles), so this must NOT reach the page as
    // an error — that would send the user to the contract-call rail for a bill already paid.
    const result = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });
    expect(result).toMatchObject({ status: 'DUPLICATE' });
  });
});

/**
 * "It fails and switches to the contract call, but if I cancel and retry the same x402 it will
 * now be successful."
 *
 * Reported on Base, with the facilitator answering `unable to estimate gas`. The refusal moved
 * nothing and did not reproduce on a fresh authorization — so the app's answer (drop to the
 * contract call, two more prompts) was strictly worse than what the user was doing by hand (one
 * more prompt on the same rail). These cover the automatic version of that, and the two lines it
 * must never cross: a settled payment, and a refusal the server did not mark retryable.
 */
/**
 * 🔴 THE VALIDITY WINDOW, WHICH IS WHAT REVERTED GAS ESTIMATION ON BASE.
 *
 * `validBefore` is measured against the CHAIN's clock, not the browser's. A device running fast,
 * or a challenge whose `maxTimeoutSeconds` is small, can hand the facilitator an authorization
 * that is already dead — and a dead authorization reverts `transferWithAuthorization` during
 * simulation, which the facilitator reports as the reported "unable to estimate gas". A floor on
 * the window is what keeps it real however far the two clocks have drifted apart.
 */
describe('payWithX402 — the signed validity window', () => {
  const windowFor = async (maxTimeoutSeconds: number | undefined) => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [{ ...accept, maxTimeoutSeconds }] }, 402)
      : jsonResponse({ success: true }, 200))));
    await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });
    const msg = wallet.calls[0].message;
    return { validAfter: Number(msg.validAfter), validBefore: Number(msg.validBefore) };
  };

  it('never signs a window shorter than 15 minutes, however small the challenge asks for', async () => {
    const now = Math.floor(Date.now() / 1000);
    // A 30-second challenge would be expired — or within the server's 60s settle margin —
    // before the payer had finished reading their wallet's prompt.
    const { validBefore } = await windowFor(30);
    expect(validBefore - now).toBeGreaterThanOrEqual(900);
  });

  it('still honours a longer window the challenge asks for, and still caps it at a day', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await windowFor(3600)).validBefore - now).toBeGreaterThanOrEqual(3600);
    expect((await windowFor(999_999)).validBefore - now).toBeLessThanOrEqual(86_400);
  });

  /**
   * 🔴 THE KNOWN-GOOD VALUE, RESTORED. thirdweb's client — under which Base x402 worked for
   * months — backdated validAfter by a full day (see preparePaymentHeader in
   * node_modules/thirdweb/dist/esm/x402/sign.js). Replacing that client narrowed it to ten
   * minutes, which is a thin margin against the clock we do not control: `validAfter` is
   * compared to `block.timestamp`, and one second over reverts as "unable to estimate gas".
   */
  it("backdates validAfter a full day, matching the client Base x402 worked under", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await windowFor(3600)).validAfter).toBeLessThanOrEqual(now - 86_400);
  });

  it('signs checksummed addresses, which the facilitator also compares as text', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      // A challenge whose payTo arrives lower-cased, as an env var easily does.
      ? jsonResponse({ accepts: [{ ...accept, payTo: PAY_TO.toLowerCase() }] }, 402)
      : jsonResponse({ success: true }, 200))));
    await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });
    expect(wallet.calls[0].message.to).toBe(PAY_TO);
    expect(wallet.calls[0].message.from).toBe(ACCOUNT);
  });
});

describe('payWithX402 — settled without a transaction hash', () => {
  /**
   * 🔴 THE REAL DOUBLE CHARGE. The facilitator answered `unable to estimate gas` for an
   * authorization it had ALREADY settled (a spent EIP-3009 nonce reverts on re-simulation), so
   * the refusal named no transaction and looked perfectly safe to retry. On Base that charged a
   * payer 1.4925 USDC twice, 140 seconds apart, for one bill. The server now asks the chain
   * whether the nonce was spent and says `settled: true` when it was — with no hash to offer,
   * because the facilitator never gave one. The client must believe it anyway.
   */
  it('treats settled:true as settled even with no tx_hash, and refuses to re-sign it', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [accept] }, 402)
      // Note `retryable: true` is ALSO present: `settled` has to win, or the guard is useless.
      : jsonResponse({ settled: true, retryable: true, error: 'Your payment went through, but we could not confirm it automatically.' }, 402))));

    const err = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT })
      .catch((e) => e);

    expect(err).toBeInstanceOf(X402PaymentError);
    expect(err.settled).toBe(true);
    expect(err.retryable).toBe(false);
    // One signature only. A second would be a second real payment.
    expect(wallet.calls.length).toBe(1);
    expect(n).toBe(2);
  });
});

describe('payWithX402 — the one automatic re-sign', () => {
  const settleRefusal = (retryable: boolean) =>
    jsonResponse({ x402Version: 1, error: 'unable to estimate gas', retryable, accepts: [accept] }, 402);

  it('re-challenges, re-signs and settles when the server says the refusal was retryable', async () => {
    const wallet = fakeWallet();
    const retries: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1 || n === 3) return jsonResponse({ accepts: [accept] }, 402); // challenges
      if (n === 2) return settleRefusal(true);                                 // first settle
      return jsonResponse({ success: true, status: 'SUCCESS', tx_hash: '0xabc' }, 200);
    }));

    const result = await payWithX402({
      url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT,
      onRetry: (reason) => retries.push(reason),
    });

    expect(result).toMatchObject({ status: 'SUCCESS' });
    expect(wallet.calls).toHaveLength(2);          // two prompts, not one — and both were asked for
    expect(retries).toEqual(['unable to estimate gas']); // …and the page was told why
  });

  it('signs a FRESH authorization on the retry — a reused nonce would revert on-chain', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1 || n === 3) return jsonResponse({ accepts: [accept] }, 402);
      if (n === 2) return settleRefusal(true);
      return jsonResponse({ success: true }, 200);
    }));

    await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT });
    expect(wallet.calls[0].message.nonce).not.toBe(wallet.calls[1].message.nonce);
  });

  it('does NOT re-sign a refusal the server left unmarked — that prompt would be wasted', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [accept] }, 402)
      : settleRefusal(false))));

    const err = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT }).catch((e) => e);
    expect(err).toBeInstanceOf(X402PaymentError);
    expect(err.retryable).toBe(false);
    expect(wallet.calls).toHaveLength(1);
  });

  it('NEVER re-signs a payment that settled, however the response is marked', async () => {
    // A tx_hash means the money moved. A second signature here is a second charge, so `settled`
    // has to beat `retryable` even when the server contradicts itself.
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? jsonResponse({ accepts: [accept] }, 402)
      : jsonResponse({ error: 'vending failed', retryable: true, tx_hash: '0xdead' }, 400))));

    const err = await payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT }).catch((e) => e);
    expect(err.settled).toBe(true);
    expect(err.retryable).toBe(false);
    expect(wallet.calls).toHaveLength(1);
  });

  it('gives up after the configured number of attempts instead of prompting forever', async () => {
    const wallet = fakeWallet();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n % 2 === 1 ? jsonResponse({ accepts: [accept] }, 402) : settleRefusal(true))));

    await expect(payWithX402({ url: '/api/pay/x402', body: {}, client: wallet.client, account: ACCOUNT }))
      .rejects.toBeInstanceOf(X402PaymentError);
    expect(wallet.calls).toHaveLength(2);
  });
});
