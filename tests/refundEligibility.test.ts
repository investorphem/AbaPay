import { describe, it, expect } from 'vitest';
import { canOfferRefund, paymentLandedOnChain } from '@/lib/refundEligibility';

// The admin ledger offers Refund only when the payment landed on chain (src/lib/refundEligibility.ts).
// 2026-11-15: it was offered on orders whose payment never arrived.

const EVM = '0x' + 'ab'.repeat(32);
const NIM = 'cd'.repeat(32);

describe('paymentLandedOnChain / canOfferRefund', () => {
  it.each([
    ['a failed vend paid on Celo', { status: 'FAILED_VENDING', tx_hash: EVM, blockchain: 'CELO' }, true],
    ['a failed vend paid in NIM', { status: 'FAILED_VENDING', tx_hash: NIM, blockchain: 'NIMIQ' }, true],
    ['a stuck PROCESSING order paid on Base', { status: 'PROCESSING', tx_hash: EVM, blockchain: 'BASE' }, true],
    ['an x402 order paid (hash on x402_settle_tx)', { status: 'PENDING', tx_hash: 'preflight_x402_CELO_0xabc_0x1', x402_settle_tx: EVM, blockchain: 'CELO' }, true],
    ['a refused x402 authorization spent afterwards', { status: 'FAILED_PAYMENT', error_code: 'X402_LATE_SETTLEMENT', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }, true],
  ])('offers a refund for %s', (_l, tx, want) => {
    expect(paymentLandedOnChain(tx)).toBe(want);
    expect(canOfferRefund(tx)).toBe(want);
  });

  it.each([
    ['a NIM order never paid (placeholder)', { status: 'PENDING', tx_hash: 'preflight_nim_1234', blockchain: 'NIMIQ' }],
    ['a web order never broadcast', { status: 'PENDING', tx_hash: 'preflight_0xabc_1700000000_x', blockchain: 'CELO' }],
    ['a FAILED_PAYMENT', { status: 'FAILED_PAYMENT', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
    ['a reverted payment', { status: 'FAILED_VENDING', error_code: 'REVERTED', tx_hash: EVM, blockchain: 'CELO' }],
    ['an agent payment that never broadcast', { status: 'FAILED_PAYMENT', error_code: 'AGENT_PREFLIGHT_FAILED', tx_hash: 'preflight_agent', blockchain: 'CELO' }],
    ['a refused x402 authorization', { status: 'FAILED_PAYMENT', error_code: 'X402_SETTLE_REFUSED', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
    ['a cancelled x402 authorization', { status: 'FAILED_PAYMENT', error_code: 'X402_AUTH_CANCELLED', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
    ['a 64-hex hash on an EVM row (not a Nimiq hash)', { status: 'FAILED_VENDING', tx_hash: NIM, blockchain: 'CELO' }],
  ])('offers no refund for %s', (_l, tx) => {
    expect(canOfferRefund(tx)).toBe(false);
  });

  it('offers no refund for an order already refunded, or one that succeeded or expired', () => {
    expect(canOfferRefund({ status: 'FAILED_VENDING', tx_hash: EVM, blockchain: 'CELO', refund_hash: EVM })).toBe(false);
    expect(canOfferRefund({ status: 'SUCCESS', tx_hash: EVM, blockchain: 'CELO' })).toBe(false);
    expect(canOfferRefund({ status: 'EXPIRED', tx_hash: 'preflight_nim_1', blockchain: 'NIMIQ' })).toBe(false);
  });
});
