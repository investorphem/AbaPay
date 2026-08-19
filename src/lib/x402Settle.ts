// ⚡ WHAT THE FACILITATOR IS ABOUT TO BE ASKED TO DO — CHECKED BEFORE IT IS ASKED
//
// 🔴 THE BUG THIS FILE EXISTS FOR:
//
//   ⚠️ x402 SETTLEMENT REJECTED (BASE)
//   HTTP 400 · USDC · 1.4925
//   {"errorMessage":"failed to send transaction: error (status 400): invalid_request:
//    unable to estimate gas","errorReason":"invalid_payload","network":"base","success":false}
//
// …followed by the payer being bounced onto the contract-call rail, and then — on cancelling
// and retrying the exact same x402 payment — a clean success. A settlement that fails once and
// succeeds on the next identical attempt is not a broken rail; it is a payload that was invalid
// AT THAT MOMENT and valid a minute later, plus an app that treated the whole rail as dead
// instead of asking again.
//
// "unable to estimate gas" is what a facilitator says when its `transferWithAuthorization`
// simulation REVERTS. EIP-3009 gives that exactly six ways to happen, and most are visible in
// the payload before anyone spends a network round-trip on it:
//
//   1. the authorization is not yet valid   (validAfter still in the future)
//   2. the authorization has expired        (validBefore already passed)
//   3. the nonce was already used
//   4. the signature does not recover to `from`
//   5. `from` does not hold `value`
//   6. the recipient is the zero address
//
// (1), (2) and (6) are decidable here, and so is the mismatch that produces (4) indirectly: a
// paymentRequirements amount that disagrees with the amount actually signed. checkAuthorization
// below decides them, so a payload that CANNOT settle is answered with a fresh challenge the
// payer can sign again — instead of being handed to the facilitator to fail obscurely, alert an
// operator, and cost the user two extra wallet prompts on the fallback rail.
//
// Pure functions, no I/O, no Next.js: this is the part of the settle path worth testing without
// a facilitator, a database or a browser (see tests/x402Settle.test.ts).

/** The EIP-3009 authorization the payer actually signed, as it arrives in the X-PAYMENT header. */
export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Pull the authorization out of a decoded X-PAYMENT envelope.
 *
 * Deliberately tolerant about the envelope (v1 and v2 shapes both nest it under `payload`) and
 * strict about the authorization itself — a missing field here becomes an unreadable revert
 * later, which is the whole thing this file is trying to stop.
 */
export function readAuthorization(decodedPayload: any): X402Authorization | null {
  const auth = decodedPayload?.payload?.authorization ?? decodedPayload?.authorization;
  if (!auth || typeof auth !== 'object') return null;
  const fields = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const;
  if (fields.some((f) => auth[f] === undefined || auth[f] === null || auth[f] === '')) return null;
  return {
    from: String(auth.from),
    to: String(auth.to),
    value: String(auth.value),
    validAfter: String(auth.validAfter),
    validBefore: String(auth.validBefore),
    nonce: String(auth.nonce),
  };
}

export type AuthorizationCheck =
  | { ok: true; chargedWei: bigint }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * How much validity an authorization must have LEFT for the facilitator to be able to use it.
 * Settling is not instant — a JWT is minted, a request crosses the internet, a transaction is
 * simulated and then mined — so an authorization expiring in three seconds is already dead.
 */
export const MIN_REMAINING_VALIDITY_SECONDS = 60;

/**
 * How far ABOVE the bill a signed amount may sit and still be settled.
 *
 * The signed `value` is what the facilitator actually transfers, so it — not our recomputed
 * price — has to be what `paymentRequirements` declares, or the two disagree and the facilitator
 * refuses. Accepting a value slightly above the bill absorbs an exchange-rate tick between the
 * challenge and the settle (the challenge's price comes from a 30s-cached rate, and the payer
 * signs somewhere in between). Anything beyond this is not a rounding difference, and is refused
 * rather than charged.
 */
export const MAX_OVERPAY_RATIO = 1.1;

/**
 * Can this authorization settle, and for how much?
 *
 * `chargedWei` is the amount that will ACTUALLY move — the signed value, not the recomputed
 * price — so callers must record and refund against it rather than against what they asked for.
 *
 * `retryable` means: a fresh challenge and a fresh signature would plausibly fix this, so it is
 * worth one more wallet prompt. It is false for anything a second identical attempt cannot
 * change (a wrong recipient, a device clock hours out), where the honest answer is a clear
 * message and the contract-call rail.
 */
export function checkAuthorization(params: {
  auth: X402Authorization | null;
  payTo: string;
  requiredWei: bigint;
  nowSec: number;
}): AuthorizationCheck {
  const { auth, payTo, requiredWei, nowSec } = params;

  // BigInt(0) rather than the `0n` literal: tsconfig targets ES2017, where the literal form is a
  // compile error (TS2737). Same value, and it keeps this file building with the rest of the app.
  const ZERO = BigInt(0);

  if (!auth) {
    return { ok: false, code: 'MALFORMED_AUTHORIZATION', retryable: false,
      message: 'The payment authorization was incomplete.' };
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(auth.to) || auth.to.toLowerCase() !== String(payTo).toLowerCase()) {
    return { ok: false, code: 'WRONG_RECIPIENT', retryable: false,
      message: 'The payment authorization named a different recipient than this payment.' };
  }

  let value: bigint, validAfter: bigint, validBefore: bigint;
  try {
    value = BigInt(auth.value);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return { ok: false, code: 'MALFORMED_AUTHORIZATION', retryable: false,
      message: 'The payment authorization carried unreadable numbers.' };
  }

  // 🔴 (1) NOT YET VALID. The client backdates validAfter by ten minutes precisely so this
  // cannot happen; reaching it means the signing device's clock is further out than that, and
  // signing again on the same device produces the same broken window. Say what is actually wrong.
  if (validAfter > BigInt(nowSec)) {
    return { ok: false, code: 'NOT_YET_VALID', retryable: false,
      message: "Your device's clock is far enough ahead that this payment authorization isn't valid yet. Check your device's date and time settings, then try again." };
  }

  // 🔴 (2) EXPIRED, or so close to it that settlement cannot finish in time. This is the
  // ordinary "signed it, then left the phone on the table" case, and a fresh signature fixes it.
  if (validBefore <= BigInt(nowSec + MIN_REMAINING_VALIDITY_SECONDS)) {
    return { ok: false, code: 'AUTHORIZATION_EXPIRED', retryable: true,
      message: 'That payment authorization expired before it could be settled.' };
  }

  if (value < requiredWei) {
    // Under by a little is a price tick between the challenge and the signature — worth
    // re-signing at the current price. Under by a lot was never this bill.
    const closeEnough = requiredWei > ZERO && value * BigInt(100) >= requiredWei * BigInt(90);
    return { ok: false, code: closeEnough ? 'PRICE_MOVED' : 'AMOUNT_MISMATCH', retryable: closeEnough,
      message: closeEnough
        ? 'The exchange rate moved while you were approving — this payment needs to be signed again at the current rate.'
        : 'The signed payment amount did not match this bill.' };
  }

  const ceiling = (requiredWei * BigInt(Math.round(MAX_OVERPAY_RATIO * 100))) / BigInt(100);
  if (requiredWei > ZERO && value > ceiling) {
    return { ok: false, code: 'AMOUNT_MISMATCH', retryable: false,
      message: 'The signed payment amount did not match this bill.' };
  }

  return { ok: true, chargedWei: value };
}

/**
 * Is a facilitator refusal worth one more attempt, or is it final?
 *
 * 🔴 THIS IS THE CALL THAT DECIDES WHETHER THE USER GETS ONE MORE PROMPT OR TWO MORE. A retryable
 * refusal is re-signed once on the x402 rail (one prompt); a final one goes to the contract call
 * (approve + payBill, two prompts). Neither outcome can cost money — this is only ever consulted
 * for a refusal that moved nothing, which settleResponseNamesTransaction proves separately.
 *
 * The permanent list is checked FIRST, because several of those bodies also contain words from
 * the transient list ("insufficient funds for gas" is not a transient gas problem).
 */
export function isRetryableSettleFailure(httpStatus: number, rawBody: string): boolean {
  const body = String(rawBody || '');

  // 🔴 THE AUTHORIZATION HAS ALREADY BEEN CONSUMED — THE MOST DANGEROUS REFUSAL THERE IS, AND
  // CHECKED BEFORE ANYTHING ELSE.
  //
  // EIP-3009 nonces are single-use, so `FiatTokenV2: authorization is used or canceled` means
  // that exact authorization ALREADY moved money — the transfer happened, and only the response
  // telling us so went missing. Marking this retryable would send the payer back to their wallet
  // to sign a FRESH nonce, which the token would happily accept: a genuine double charge, paid
  // for by the one person who did nothing wrong.
  //
  // It is first because the phrasings below would otherwise both claim it. A used authorization
  // reverts during simulation, so the facilitator reports it as "unable to estimate gas" — the
  // same words as the transient case — and "nonce already used" would be caught by the tx-nonce
  // rule further down. Answering `false` here is strictly safer than either: the worst case is a
  // payer sent to the contract-call rail for a payment that had truly failed, which costs two
  // prompts and no money.
  if (/authorization is used|authorization.{0,20}(used|canceled|cancelled)|nonce.{0,20}already (been )?used|already used/i.test(body)) return false;

  // Nothing a fresh signature can change: the payer is short, we are out of facilitator credit,
  // the network or scheme is not one the facilitator serves, or it rejected our credentials.
  if (/insufficient|balance[_ ]?too[_ ]?low|credit|invalid[_ ]?network|unsupported|unauthorized|forbidden|invalid[_ ]?scheme/i.test(body)) return false;
  if (httpStatus === 401 || httpStatus === 403) return false;

  // The reported Base failure. A revert during gas estimation that is NOT one of the permanent
  // causes above is the facilitator simulating against a state it could not read — the exact
  // shape that clears on a second attempt, which is what people were already doing by hand.
  //
  // Safe despite the ambiguity noted above: gas is estimated BEFORE a transaction is broadcast,
  // so an estimation failure is a refusal that never reached the chain. The one path that could
  // have broadcast and still reported an error is a fetch that threw, and route.ts deliberately
  // treats that as non-retryable rather than guessing.
  if (/estimate ?gas|invalid_payload|invalid_request/i.test(body)) return true;

  // Ordinary transport-shaped failures.
  //
  // ⚡ "nonce" HERE MEANS THE FACILITATOR'S OWN TRANSACTION NONCE, NOT THE PAYER'S AUTHORIZATION
  // NONCE. `nonce too low` and `replacement transaction underpriced` are its EOA racing itself
  // under load — the authorization is untouched, so the same one settles on a second attempt.
  // Spelled out rather than matching a bare `nonce`, which also matched the used-authorization
  // case above and would have turned a completed payment into a second one.
  if (/timeout|timed out|temporar|unavailable|try again|rate.?limit|too many requests/i.test(body)) return true;
  if (/nonce too (low|high)|replacement|underpriced/i.test(body)) return true;
  if (httpStatus >= 500 || httpStatus === 408 || httpStatus === 429) return true;

  return false;
}

/**
 * Did the facilitator's refusal nonetheless put a transaction on chain?
 *
 * If it names one, money may already have moved and NOTHING may be retried — not by the server,
 * not by the client, not on the contract-call rail. Checked independently of the reason text,
 * because a hash is evidence and a message is prose.
 */
export function settleResponseNamesTransaction(parsed: any): boolean {
  const tx = parsed?.transaction ?? parsed?.txHash ?? parsed?.tx_hash;
  return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx.trim());
}
