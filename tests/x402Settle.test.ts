import { describe, it, expect } from 'vitest';
import {
  readAuthorization,
  checkAuthorization,
  isRetryableSettleFailure,
  settleResponseNamesTransaction,
  MIN_REMAINING_VALIDITY_SECONDS,
} from '@/lib/x402Settle';

/**
 * The rejection this file exists to stop being mysterious:
 *
 *   ⚠️ x402 SETTLEMENT REJECTED (BASE) — HTTP 400 · USDC · 1.4925
 *   {"errorMessage":"failed to send transaction: error (status 400): invalid_request:
 *    unable to estimate gas","errorReason":"invalid_payload","network":"base","success":false}
 *
 * …and then the same payment, cancelled and retried by hand, settling cleanly. "Unable to
 * estimate gas" is a REVERTED simulation; EIP-3009 has a handful of ways to revert, and the ones
 * visible in the payload are decided here instead of being discovered by the facilitator.
 */

const PAY_TO = '0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488';
const NOW = 1_760_000_000;

const authorization = (over: Record<string, unknown> = {}) => ({
  from: '0xec24bAfBc989a9bE5f6F0eAD8848753B5E4aE0B6',
  to: PAY_TO,
  value: '1492500',
  validAfter: String(NOW - 600),
  validBefore: String(NOW + 86_400),
  nonce: '0x' + 'ab'.repeat(32),
  ...over,
});

const check = (over: Record<string, unknown> = {}, requiredWei = 1_492_500n) =>
  checkAuthorization({ auth: authorization(over) as any, payTo: PAY_TO, requiredWei, nowSec: NOW });

describe('readAuthorization', () => {
  it('reads the authorization out of the envelope the app sends', () => {
    const auth = readAuthorization({ x402Version: 2, scheme: 'exact', payload: { signature: '0xsig', authorization: authorization() } });
    expect(auth?.value).toBe('1492500');
    expect(auth?.to).toBe(PAY_TO);
  });

  it('reads a flat envelope too, since both shapes are in the wild', () => {
    expect(readAuthorization({ authorization: authorization() })?.nonce).toBe('0x' + 'ab'.repeat(32));
  });

  it('refuses an authorization missing a field rather than settling a half one', () => {
    const { validBefore, ...partial } = authorization();
    expect(readAuthorization({ payload: { authorization: partial } })).toBeNull();
    expect(readAuthorization({})).toBeNull();
    expect(readAuthorization(null)).toBeNull();
  });
});

describe('checkAuthorization', () => {
  it('accepts the ordinary payment and reports what will actually move', () => {
    const result = check();
    expect(result.ok).toBe(true);
    expect(result.ok && result.chargedWei).toBe(1_492_500n);
  });

  it('charges the SIGNED value, not the recomputed price — they can disagree by a rate tick', () => {
    // The challenge was priced a moment earlier at a slightly different rate. The facilitator
    // transfers what the payer signed, so that is the figure the requirements must declare and
    // the figure the receipt, the vend and any refund have to be built from.
    const result = check({ value: '1500000' }, 1_492_500n);
    expect(result.ok && result.chargedWei).toBe(1_500_000n);
  });

  it('refuses an amount far above the bill instead of quietly charging it', () => {
    const result = check({ value: '3000000' }, 1_492_500n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('AMOUNT_MISMATCH');
    expect(!result.ok && result.retryable).toBe(false);
  });

  it('asks for a re-sign when the rate moved under the payer mid-approval', () => {
    const result = check({ value: '1450000' }, 1_492_500n);
    expect(!result.ok && result.code).toBe('PRICE_MOVED');
    expect(!result.ok && result.retryable).toBe(true);
  });

  it('refuses — without a retry — an amount that was never this bill', () => {
    const result = check({ value: '10000' }, 1_492_500n);
    expect(!result.ok && result.code).toBe('AMOUNT_MISMATCH');
    expect(!result.ok && result.retryable).toBe(false);
  });
});

describe('checkAuthorization — the validity window, which is what reverts gas estimation', () => {
  it('sends an expired authorization back for a fresh signature', () => {
    const result = check({ validBefore: String(NOW - 1) });
    expect(!result.ok && result.code).toBe('AUTHORIZATION_EXPIRED');
    expect(!result.ok && result.retryable).toBe(true);
  });

  it('treats one about to expire as expired — settling is not instantaneous', () => {
    const result = check({ validBefore: String(NOW + MIN_REMAINING_VALIDITY_SECONDS - 1) });
    expect(!result.ok && result.code).toBe('AUTHORIZATION_EXPIRED');
  });

  it('names the device clock when validAfter is still in the future, and does NOT retry', () => {
    // The client backdates validAfter by ten minutes, so reaching this means the clock is out by
    // more than that — and signing again on the same device reproduces it exactly. Saying
    // "check your date and time" is the only answer that gets the user anywhere.
    const result = check({ validAfter: String(NOW + 60) });
    expect(!result.ok && result.code).toBe('NOT_YET_VALID');
    expect(!result.ok && result.retryable).toBe(false);
    expect(!result.ok && result.message).toMatch(/clock|date and time/i);
  });
});

describe('checkAuthorization — the recipient', () => {
  it('refuses an authorization that pays someone else', () => {
    const result = check({ to: '0x0000000000000000000000000000000000000001' });
    expect(!result.ok && result.code).toBe('WRONG_RECIPIENT');
    expect(!result.ok && result.retryable).toBe(false);
  });

  it('does not care about address casing', () => {
    expect(check({ to: PAY_TO.toLowerCase() }).ok).toBe(true);
  });

  it('refuses a missing or unreadable authorization outright', () => {
    const none = checkAuthorization({ auth: null, payTo: PAY_TO, requiredWei: 1n, nowSec: NOW });
    expect(!none.ok && none.code).toBe('MALFORMED_AUTHORIZATION');
    const junk = check({ value: 'not-a-number' });
    expect(!junk.ok && junk.code).toBe('MALFORMED_AUTHORIZATION');
  });
});

describe('isRetryableSettleFailure', () => {
  const REPORTED_BASE_REJECTION = JSON.stringify({
    errorMessage: 'failed to send transaction: error (status 400): invalid_request: unable to estimate gas',
    errorReason: 'invalid_payload',
    network: 'base',
    payer: '0xec24bAfBc989a9bE5f6F0eAD8848753B5E4aE0B6',
    success: false,
  });

  it('retries the exact rejection that was reported on Base', () => {
    expect(isRetryableSettleFailure(400, REPORTED_BASE_REJECTION)).toBe(true);
  });

  it('does NOT retry a payer who is simply short of funds', () => {
    // Note this body ALSO contains the word "gas" — the permanent check has to win, or every
    // insufficient-balance payment costs the user a pointless second signature prompt.
    expect(isRetryableSettleFailure(400, '{"errorMessage":"insufficient funds for gas * price + value"}')).toBe(false);
  });

  it('does NOT retry our own operator problems — credits, credentials, an unserved network', () => {
    expect(isRetryableSettleFailure(402, '{"error":"insufficient credits"}')).toBe(false);
    expect(isRetryableSettleFailure(401, 'unauthorized')).toBe(false);
    expect(isRetryableSettleFailure(400, '{"errorReason":"invalid_network"}')).toBe(false);
  });

  it('retries transport-shaped failures', () => {
    expect(isRetryableSettleFailure(503, 'service temporarily unavailable')).toBe(true);
    expect(isRetryableSettleFailure(429, 'too many requests')).toBe(true);
    expect(isRetryableSettleFailure(504, '')).toBe(true);
  });

  it('leaves an unrecognised refusal alone rather than guessing', () => {
    expect(isRetryableSettleFailure(400, '{"errorReason":"something new"}')).toBe(false);
  });

  /**
   * 🔴 THE DOUBLE CHARGE THIS FUNCTION CAN CAUSE IF IT GETS ONE CASE WRONG.
   *
   * An EIP-3009 nonce is single-use, so "authorization is used" means that authorization ALREADY
   * moved the money — only the response saying so went missing. Calling it retryable sends the
   * payer back to their wallet for a FRESH nonce the token will happily accept, and they pay
   * twice for one bill.
   */
  it('NEVER retries an authorization that has already been consumed — that is a double charge', () => {
    // USDC's own revert string.
    expect(isRetryableSettleFailure(400, 'FiatTokenV2: authorization is used or canceled')).toBe(false);
    // And wrapped the way a facilitator actually reports a reverted simulation — the words
    // "estimate gas" are present, and must NOT win over this.
    expect(isRetryableSettleFailure(400, JSON.stringify({
      errorMessage: 'failed to send transaction: unable to estimate gas: execution reverted: FiatTokenV2: authorization is used or canceled',
      errorReason: 'invalid_payload',
    }))).toBe(false);
    expect(isRetryableSettleFailure(400, 'nonce already used')).toBe(false);
    expect(isRetryableSettleFailure(400, 'authorization already used')).toBe(false);
  });

  it("still retries the facilitator's OWN transaction-nonce races — a different nonce entirely", () => {
    // Its EOA racing itself under load. The payer's authorization is untouched, so the very
    // same one settles on the next attempt.
    expect(isRetryableSettleFailure(500, 'nonce too low')).toBe(true);
    expect(isRetryableSettleFailure(500, 'replacement transaction underpriced')).toBe(true);
  });
});

describe('settleResponseNamesTransaction', () => {
  it('is the veto on every retry: a named transaction means money may already have moved', () => {
    expect(settleResponseNamesTransaction({ success: false, transaction: '0x' + '1'.repeat(64) })).toBe(true);
    expect(settleResponseNamesTransaction({ success: false, tx_hash: '0x' + 'f'.repeat(64) })).toBe(true);
  });

  it('is not fooled by the empty placeholders facilitators send on a failure', () => {
    expect(settleResponseNamesTransaction({ success: false, transaction: '' })).toBe(false);
    expect(settleResponseNamesTransaction({ success: false, transaction: '0x' })).toBe(false);
    expect(settleResponseNamesTransaction({ success: false })).toBe(false);
    expect(settleResponseNamesTransaction(null)).toBe(false);
  });
});
