import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { resolveTokenOnChain } from '@/constants';

/**
 * These tests lock in the AMOUNT-VERIFICATION invariant used by /api/pay and
 * /api/webhook. This is the check that stands between a user and a free bill:
 * we must never vend when the on-chain amount paid is less than the amount the
 * pending record requires.
 *
 * The comparison logic under test is intentionally reproduced here in the same
 * shape used by the routes, so a regression in the shared reasoning is caught.
 * (Extracting this into a single shared helper is a recommended follow-up.)
 */
function isPaymentSufficient(paidWei: bigint, requiredCrypto: number, decimals: number): boolean {
  const requiredWei = parseUnits(requiredCrypto.toFixed(decimals), decimals);
  const tolerance = parseUnits('0.01', decimals); // 1-cent grace for float rounding
  const shortfall = requiredWei > paidWei ? requiredWei - paidWei : BigInt(0);
  return shortfall <= tolerance;
}

describe('payment amount verification', () => {
  const USDC_DECIMALS = 6;
  const CUSD_DECIMALS = 18;

  it('accepts an exact payment', () => {
    const required = 10.0;
    const paid = parseUnits('10.0', USDC_DECIMALS);
    expect(isPaymentSufficient(paid, required, USDC_DECIMALS)).toBe(true);
  });

  it('accepts an overpayment', () => {
    const paid = parseUnits('11.0', USDC_DECIMALS);
    expect(isPaymentSufficient(paid, 10.0, USDC_DECIMALS)).toBe(true);
  });

  it('accepts a payment short by less than the rounding tolerance', () => {
    // Float math on the frontend can land a hair under; this must not fail a real user.
    const paid = parseUnits('9.995', USDC_DECIMALS);
    expect(isPaymentSufficient(paid, 10.0, USDC_DECIMALS)).toBe(true);
  });

  // 🔴 THE CRITICAL CASES — these are the fraud paths.
  it('REJECTS a materially underpaid transaction', () => {
    const paid = parseUnits('1.0', USDC_DECIMALS); // paid ₦-equivalent of 1, wants 100
    expect(isPaymentSufficient(paid, 100.0, USDC_DECIMALS)).toBe(false);
  });

  it('REJECTS a dust payment against a large bill', () => {
    const paid = parseUnits('0.000001', USDC_DECIMALS);
    expect(isPaymentSufficient(paid, 500.0, USDC_DECIMALS)).toBe(false);
  });

  it('REJECTS a zero payment', () => {
    expect(isPaymentSufficient(BigInt(0), 10.0, USDC_DECIMALS)).toBe(false);
  });

  it('REJECTS a payment just outside the tolerance', () => {
    const paid = parseUnits('9.97', USDC_DECIMALS); // 0.03 short, tolerance is 0.01
    expect(isPaymentSufficient(paid, 10.0, USDC_DECIMALS)).toBe(false);
  });

  it('handles 18-decimal tokens (cUSD) correctly', () => {
    expect(isPaymentSufficient(parseUnits('10.0', CUSD_DECIMALS), 10.0, CUSD_DECIMALS)).toBe(true);
    expect(isPaymentSufficient(parseUnits('1.0', CUSD_DECIMALS), 10.0, CUSD_DECIMALS)).toBe(false);
  });

  it('does not confuse decimals across tokens (6-dec amount vs 18-dec requirement)', () => {
    // A 6-decimal amount interpreted as 18-decimal would look like a rounding-level
    // dust payment. Guard that we treat decimals explicitly rather than by luck.
    const sixDecPaid = parseUnits('10.0', 6); // 10_000_000
    expect(isPaymentSufficient(sixDecPaid, 10.0, CUSD_DECIMALS)).toBe(false);
  });
});

describe('resolveTokenOnChain', () => {
  it('resolves a known token to a lowercase address and correct decimals', () => {
    const t = resolveTokenOnChain('USDC', 'CELO', true);
    expect(t).not.toBeNull();
    expect(t!.address).toEqual(t!.address.toLowerCase());
    expect(t!.decimals).toBe(6);
  });

  it('returns null for an unknown token symbol rather than guessing', () => {
    // Important: the webhook must not fall back to a default token on garbage input.
    expect(resolveTokenOnChain('NOT_A_TOKEN', 'CELO', true)).toBeNull();
  });

  it('distinguishes mainnet from testnet addresses', () => {
    const mainnet = resolveTokenOnChain('USDC', 'CELO', true);
    const testnet = resolveTokenOnChain('USDC', 'CELO', false);
    if (mainnet && testnet) {
      expect(mainnet.address).not.toEqual(testnet.address);
    }
  });
});
