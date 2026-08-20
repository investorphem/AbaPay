import { getAddress, type WalletClient } from 'viem';

// ⚡ x402 PAYMENT, SIGNED BY THE WALLET THE USER ALREADY CONNECTED
//
// 🔴 THE BUG THIS FIXES: FOUR WALLET POPUPS FOR ONE BILL.
//
// x402 signing used to go through thirdweb's own wallet stack (useFetchWithPayment + a
// viemAdapter wallet registered as thirdweb's "active wallet"). That stack is a SECOND wallet
// connection living beside the wagmi one the whole app already uses, and it has to establish
// itself before it can sign — which over WalletConnect surfaces to the user as another
// connection request. Reported from Valora, with screenshots: connect (1), an approval that the
// wallet announced as "Connection to AbaPay was successful!" (2), then — the x402 attempt having
// produced no signature — the contract-call fallback's approve (3) and payBill (4).
//
// Nothing about x402 requires that stack. The protocol is: ask, get a 402 challenge, sign an
// EIP-3009 `transferWithAuthorization` over the challenge's own terms, ask again with the
// signature in an `X-PAYMENT` header. All of it is done here with the SAME viem WalletClient
// that signs every contract call in the app, so a payment costs exactly one prompt on the same
// connection the user already approved — no second stack, no second handshake.
//
// It also buys the thing the old path could not give: the SERVER'S ANSWER. thirdweb's fetch
// wrapper throws a bare Error on any non-2xx, so the page could not tell "the facilitator
// rejected this, nothing moved" from "this settled and then something later failed" — and it
// fell back to a second, real payment either way. `settled` below is that distinction, and it
// is the difference between one charge and two.

export interface X402Accept {
  scheme: string;
  network: string;              // CAIP-2, e.g. "eip155:8453"
  amount?: string;
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: { name: string; version: string; primaryType?: string };
}

/**
 * A settlement attempt that did not produce a delivered bill.
 *
 * `settled` is the load-bearing field. TRUE means the facilitator moved the user's money and the
 * failure happened afterwards — retrying ANYTHING at that point charges them twice. FALSE means
 * nothing moved and the contract-call rail is safe to offer.
 */
export class X402PaymentError extends Error {
  constructor(
    message: string,
    public readonly settled: boolean,
    public readonly txHash?: string,
    public readonly httpStatus?: number,
    /**
     * Is signing this AGAIN, against a fresh challenge, worth one more prompt?
     *
     * 🔴 THE BUG THIS FIELD EXISTS FOR: "it fails, I cancel and retry the same x402, and then it
     * goes through". Reported on Base with the facilitator answering
     * `unable to estimate gas` / `invalid_payload` — a refusal that carries no transaction, so
     * nothing moved, and that a fresh authorization (new nonce, new validity window, the
     * server's current price) simply does not reproduce. The app's answer used to be the
     * contract-call rail: TWO more prompts (approve + payBill) for a bill the fast rail would
     * have taken on a second attempt costing ONE. The server marks these `retryable`, and one
     * re-sign is attempted before the fallback — the same thing the user was doing by hand.
     *
     * Never set when the payment SETTLED: a retry after money has moved is a double charge, and
     * `settled` always wins over this flag.
     */
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'X402PaymentError';
  }
}

/** Raised when the endpoint didn't challenge us at all — there is nothing to sign. */
export class X402ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402ChallengeError';
  }
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function toBase64(value: string): string {
  // btoa is byte-oriented; the JSON here is ASCII (hex + addresses + CAIP-2), so this is safe
  // and avoids pulling a Buffer polyfill into the browser bundle.
  return btoa(value);
}

/**
 * Read the challenge out of a 402 response.
 *
 * Both shapes are accepted because both are in the wild and our own server sends both at once:
 * the `payment-required` header carries v2 (what x402 discovery crawlers parse) while the BODY
 * carries v1 (what older clients read). Either is enough to sign.
 */
export function parseX402Challenge(res: Response, body: unknown): X402Accept {
  const fromBody = (body as { accepts?: unknown })?.accepts;
  let accepts: X402Accept[] | undefined = Array.isArray(fromBody) ? (fromBody as X402Accept[]) : undefined;

  if (!accepts?.length) {
    const header = res.headers.get('payment-required');
    if (header) {
      try {
        const decoded = JSON.parse(atob(header)) as { accepts?: unknown };
        if (Array.isArray(decoded?.accepts)) accepts = decoded.accepts as X402Accept[];
      } catch { /* fall through to the error below */ }
    }
  }

  const exact = accepts?.find((a) => a?.scheme === 'exact' && a?.payTo && a?.asset);
  if (!exact) throw new X402ChallengeError('This payment could not be prepared — no usable payment challenge was returned.');
  return exact as X402Accept;
}

export interface X402PayParams {
  url: string;
  /** The request body, sent identically on the challenge and the paid retry. */
  body: unknown;
  client: WalletClient;
  account: `0x${string}`;
  /**
   * Chain the wallet is actually on. The challenge's CAIP-2 network is authoritative for the
   * signature, but a mismatch means the wallet would sign for a chain it isn't connected to —
   * caught here rather than as an opaque facilitator rejection after a prompt.
   */
  expectedChainId?: number;
  /**
   * Wraps ONLY the wallet's signature call in the caller's timeout.
   *
   * 🔴 IT MUST NOT WRAP THE WHOLE PAYMENT. The budget exists for one thing: a wallet that never
   * answers. Stretch it over the settle request too and the clock is running on the facilitator
   * while the user has already signed — which would surface as "your wallet didn't respond" for
   * a payment that is, at that moment, being settled on-chain.
   *
   * ⚡ AND A SIGNATURE THAT ARRIVES LATE CANNOT SETTLE BEHIND OUR BACK. This is the property the
   * whole Valora fix rests on, so it is stated here rather than assumed: the settle request is
   * posted BY THIS FUNCTION, from the line after the signature is awaited. If the caller's
   * wrapper rejects, this function unwinds and never posts anything — the wallet may still
   * produce a signature a minute later, and it goes precisely nowhere, because nobody is left to
   * hand it to the facilitator. So a signature timeout means "nothing moved and nothing can",
   * which makes it safe for the page to fall back to the contract-call rail. It was NOT safe
   * under the old thirdweb client, which owned the settle request itself and could complete it
   * after our timeout had already fired — and the comment that used to live here still said so.
   */
  wrapSignature?: <T>(promise: Promise<T>) => Promise<T>;
  /**
   * How many complete challenge → sign → settle attempts before giving up. Default 2: one
   * ordinary attempt plus one re-sign, and only when the SERVER marked the refusal retryable.
   *
   * See X402PaymentError.retryable — this is the automatic version of the workaround people
   * found by hand ("cancel and retry the same x402 and it goes through"), and it is cheaper than
   * the alternative it replaces: one more prompt on this rail, versus two on the contract call.
   */
  maxAttempts?: number;
  /**
   * Called just before the wallet is asked to sign again, with the facilitator's own reason.
   * The page uses it to say why a second prompt is appearing — an unexplained one reads as an
   * app that ignored the first.
   */
  onRetry?: (reason: string, nextAttempt: number) => void;
}

/**
 * Run one full x402 payment: challenge → signature → settle.
 *
 * Resolves with the server's final JSON (the vend result). Throws X402PaymentError with
 * `settled` set when the payment could not be completed.
 *
 * Retries the WHOLE cycle (fresh challenge, fresh nonce, fresh signature) when the server says
 * the refusal was retryable and nothing moved — see maxAttempts.
 */
export async function payWithX402(params: X402PayParams): Promise<Record<string, unknown>> {
  // 🔴 ONE SIGNATURE. The default is 1 — the wallet is asked once, and if that payment cannot be
  // completed the page falls back to the contract call rather than asking again on this rail.
  //
  // It defaulted to 2, to automate the workaround people had found by hand ("cancel and retry the
  // same x402 and it goes through"). That reasoning was sound only while the first attempt failed
  // for a genuinely transient reason. It stopped being true the moment the FIRST attempt began
  // failing reproducibly: the re-sign then stopped being a rescue and became a second wallet
  // prompt on every single payment, which looks exactly like an app that ignored the first one.
  //
  // A retry that is needed every time is not a retry, it is a bug with a workaround attached.
  // The server still retries once on its own, against the SAME authorization and only while the
  // chain says its nonce is unspent — that costs the payer nothing and asks them for nothing.
  const attempts = Math.max(1, params.maxAttempts ?? 1);

  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptX402Payment(params);
    } catch (e) {
      // `settled` always wins: the money has moved, and a second attempt would move it again.
      const canRetry = e instanceof X402PaymentError && e.retryable && !e.settled && attempt < attempts;
      if (!canRetry) throw e;
      params.onRetry?.((e as X402PaymentError).message, attempt + 1);
    }
  }
}

/** One attempt: challenge → signature → settle. Every retry starts again from the challenge. */
async function attemptX402Payment({ url, body, client, account, expectedChainId, wrapSignature }: X402PayParams): Promise<Record<string, unknown>> {
  const post = (headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // 1. Ask, and expect to be told what payment is required.
  const challengeRes = await post({});
  const challengeBody = await challengeRes.json().catch(() => ({}));

  // A 2xx here means the server decided no payment was needed — hand it straight back rather
  // than inventing a signature request for a bill that is already answered.
  if (challengeRes.ok) return challengeBody;

  if (challengeRes.status !== 402) {
    throw new X402PaymentError(
      challengeBody?.message || challengeBody?.error || `Payment could not be started (${challengeRes.status}).`,
      false,
      undefined,
      challengeRes.status,
    );
  }

  const accept = parseX402Challenge(challengeRes, challengeBody);
  const chainId = Number(String(accept.network).split(':')[1]);
  if (!Number.isFinite(chainId)) throw new X402ChallengeError('This payment could not be prepared — the payment challenge named an unrecognised network.');
  if (expectedChainId && chainId !== expectedChainId) {
    throw new X402ChallengeError('Your wallet is on a different network from this payment. Switch networks and try again.');
  }

  const value = accept.maxAmountRequired ?? accept.amount;
  if (!value) throw new X402ChallengeError('This payment could not be prepared — the payment challenge carried no amount.');

  // 2. Sign the authorization. `validBefore` is bounded by the challenge's own timeout so a
  //    signature can't outlive the offer it was made against.
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    // ⚡ CHECKSUMMED, AS THE WORKING CLIENT DID. EIP-712 encodes an `address` as 20 bytes, so
    // casing cannot change the signature — but these same strings are also compared as TEXT by
    // the facilitator against `paymentRequirements.payTo`, and there a case difference is a
    // difference. thirdweb ran both through getAddress(); so does this.
    from: getAddress(account) as `0x${string}`,
    to: getAddress(accept.payTo as string) as `0x${string}`,
    value,
    // 🔴 BACKDATED A FULL DAY — THIS IS THE KNOWN-GOOD VALUE, NOT A GUESS.
    //
    // thirdweb's client (node_modules/thirdweb/dist/esm/x402/sign.js, preparePaymentHeader) used
    // `now - 86400`, and Base x402 worked under it for months. This file replaced that client
    // and quietly narrowed the backdate to ten minutes, which is a much thinner margin against
    // the one clock we do not control: the CHAIN's. `validAfter` is compared to `block.timestamp`
    // inside transferWithAuthorization, and a validAfter even one second ahead of it reverts —
    // surfacing as the facilitator's opaque "unable to estimate gas" with nothing the user could
    // possibly act on. A day of margin costs nothing (the authorization's LIFETIME is governed by
    // validBefore, and replay by the single-use nonce) and removes the failure mode entirely.
    validAfter: String(now - 86_400),
    // Likewise the challenge's own timeout, as thirdweb used it, so a signature cannot outlive
    // the offer it was made against. Floored only so a challenge asking for a nonsensically
    // short window can't produce an authorization that expires before settlement finishes.
    validBefore: String(now + Math.max(900, Math.min(accept.maxTimeoutSeconds ?? 3600, 86_400))),
    nonce: randomNonce(),
  };

  const signPromise = client.signTypedData({
    account,
    domain: {
      name: accept.extra?.name ?? 'USDC',
      version: accept.extra?.version ?? '2',
      chainId,
      verifyingContract: accept.asset as `0x${string}`,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const signature = await (wrapSignature ? wrapSignature(signPromise) : signPromise);

  // 3. Pay. The envelope declares v2 with the CAIP-2 network, matching what the challenge
  //    offered; our server normalises the version/network per facilitator before settling, and
  //    none of those fields are part of the signed message.
  const paymentHeader = toBase64(JSON.stringify({
    x402Version: 2,
    scheme: 'exact',
    network: accept.network,
    payload: { signature, authorization },
  }));

  const settleRes = await post({ 'X-PAYMENT': paymentHeader });
  const settleBody = await settleRes.json().catch(() => ({}));

  if (settleRes.ok) return settleBody;

  // A duplicate is an ANSWER, not a fault. The server runs that check immediately before it
  // settles (see /api/pay/x402), so nothing moved and there is nothing to retry — hand it back
  // as data so the page can say "you already paid this today" instead of treating a 409 as a
  // settlement failure and offering the contract-call rail for a bill already paid.
  if (settleRes.status === 409 || (settleBody as { status?: string })?.status === 'DUPLICATE') {
    return settleBody;
  }

  // 🔴 THE ONE DISTINCTION THAT MATTERS. A tx_hash in a failure response means the facilitator
  // ALREADY MOVED THE MONEY and the trouble came after (the server couldn't vend it, and has
  // queued a refund). Anything that retries from here bills the user a second time.
  //
  // ⚡ AND A HASH IS NOT THE ONLY PROOF OF THAT. When the facilitator refuses with an error it
  // gives for BOTH "nothing happened yet" and "it already happened" — `unable to estimate gas`,
  // which is what re-simulating a spent EIP-3009 nonce produces — the server asks the chain
  // directly whether the authorization was consumed, and answers `settled: true` when it was.
  // There is no transaction hash in that case (the facilitator never told us one), but the money
  // has moved just as surely, and the page must not fall back to the contract-call rail. This
  // exact case charged a payer 1.4925 USDC twice, 140 seconds apart, for one bill.
  const txHash: string | undefined = settleBody?.tx_hash;
  const settledWithoutHash = (settleBody as { settled?: unknown })?.settled === true;
  throw new X402PaymentError(
    settleBody?.error || settleBody?.message || `Payment could not be settled (${settleRes.status}).`,
    Boolean(txHash) || settledWithoutHash,
    txHash,
    settleRes.status,
    // Only the SERVER gets to call a refusal worth another signature — it is the side that saw
    // the facilitator's actual answer and asked the chain whether the authorization was spent.
    Boolean((settleBody as { retryable?: unknown })?.retryable) && !txHash && !settledWithoutHash,
  );
}
