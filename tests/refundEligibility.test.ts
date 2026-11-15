import { describe, it, expect } from 'vitest';
import { canOfferRefund, paymentLandedOnChain } from '@/lib/refundEligibility';

// The admin ledger offers Refund only when the payment landed on chain (src/lib/refundEligibility.ts).
// 2026-11-15: it was offered on orders whose payment never arrived. NIM and Celo/Base are separate
// rails, judged separately: x402 is Celo/Base only.

const EVM = '0x' + 'ab'.repeat(32);
const NIM = 'cd'.repeat(32);

describe('NIM orders (Nimiq chain)', () => {
  it('offers a refund for a paid NIM order whose vend failed, or that is stuck', () => {
    expect(canOfferRefund({ status: 'FAILED_VENDING', tx_hash: NIM, blockchain: 'NIMIQ' })).toBe(true);
    expect(canOfferRefund({ status: 'PROCESSING', tx_hash: NIM, blockchain: 'NIMIQ' })).toBe(true);
  });

  it.each([
    ['an order never paid (placeholder)', { status: 'PENDING', tx_hash: 'preflight_nim_1234' }],
    ['an expired order', { status: 'EXPIRED', tx_hash: 'preflight_nim_1234' }],
    ['a FAILED_PAYMENT', { status: 'FAILED_PAYMENT', tx_hash: NIM }],
    ['an EVM-style hash on a NIM row', { status: 'FAILED_VENDING', tx_hash: EVM }],
    ['an order already refunded', { status: 'FAILED_VENDING', tx_hash: NIM, refund_hash: NIM }],
  ])('offers no refund for %s', (_l, tx) => {
    expect(canOfferRefund({ ...tx, blockchain: 'NIMIQ' })).toBe(false);
  });

  it('ignores x402 fields on a NIM row — x402 is not a NIM rail', () => {
    expect(paymentLandedOnChain({ status: 'FAILED_PAYMENT', error_code: 'X402_LATE_SETTLEMENT', tx_hash: 'preflight_nim_1', blockchain: 'NIMIQ' })).toBe(false);
    expect(paymentLandedOnChain({ status: 'PENDING', tx_hash: 'preflight_nim_1', x402_settle_tx: EVM, blockchain: 'NIMIQ' })).toBe(false);
  });
});

describe('Celo / Base orders (payBill, relayer, x402)', () => {
  it.each([
    ['a failed vend paid on Celo', { status: 'FAILED_VENDING', tx_hash: EVM, blockchain: 'CELO' }],
    ['a stuck PROCESSING order on Base', { status: 'PROCESSING', tx_hash: EVM, blockchain: 'BASE' }],
    ['an x402 order paid (hash on x402_settle_tx)', { status: 'PENDING', tx_hash: 'preflight_x402_CELO_0xabc_0x1', x402_settle_tx: EVM, blockchain: 'CELO' }],
    ['a refused x402 authorization spent afterwards', { status: 'FAILED_PAYMENT', error_code: 'X402_LATE_SETTLEMENT', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
  ])('offers a refund for %s', (_l, tx) => {
    expect(canOfferRefund(tx)).toBe(true);
  });

  it.each([
    ['a web order never broadcast', { status: 'PENDING', tx_hash: 'preflight_0xabc_1700000000_x', blockchain: 'CELO' }],
    ['a FAILED_PAYMENT', { status: 'FAILED_PAYMENT', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
    ['a reverted payment', { status: 'FAILED_VENDING', error_code: 'REVERTED', tx_hash: EVM, blockchain: 'CELO' }],
    ['an agent payment that never broadcast', { status: 'FAILED_PAYMENT', error_code: 'AGENT_PREFLIGHT_FAILED', tx_hash: 'preflight_agent', blockchain: 'BASE' }],
    ['a refused x402 authorization', { status: 'FAILED_PAYMENT', error_code: 'X402_SETTLE_REFUSED', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
    ['a cancelled x402 authorization', { status: 'FAILED_PAYMENT', error_code: 'X402_AUTH_CANCELLED', tx_hash: 'preflight_x402_CELO_0xabc_0x1', blockchain: 'CELO' }],
    ['a Nimiq-style hash on a Celo row', { status: 'FAILED_VENDING', tx_hash: NIM, blockchain: 'CELO' }],
    ['an order already refunded', { status: 'FAILED_VENDING', tx_hash: EVM, blockchain: 'CELO', refund_hash: EVM }],
    ['a delivered order', { status: 'SUCCESS', tx_hash: EVM, blockchain: 'CELO' }],
  ])('offers no refund for %s', (_l, tx) => {
    expect(canOfferRefund(tx)).toBe(false);
  });
});
