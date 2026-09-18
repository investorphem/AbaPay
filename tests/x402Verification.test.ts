import { describe, it, expect } from 'vitest';
import { needsX402Verification } from '@/lib/parity';

/**
 * Locks in which x402 categories require a VTpass merchant-verify pass before vending
 * (see the "CUSTOMER VERIFICATION" block in /api/pay/x402/route.ts). Must stay in sync
 * with /api/pay's own inline `needsVerification` flag — same categories, same
 * SHOWMAX/jamb carve-outs, just reached through x402's serviceCategory/network naming.
 */
describe('needsX402Verification', () => {
  it('requires verification for ELECTRICITY', () => {
    expect(needsX402Verification('ELECTRICITY', 'ikeja-electric', null, false)).toBe(true);
  });

  it('requires verification for BANK', () => {
    expect(needsX402Verification('BANK', 'moniepoint-transfer', 'moniepoint', false)).toBe(true);
  });

  it('requires verification for EDUCATION only when the provider is jamb', () => {
    expect(needsX402Verification('EDUCATION', 'jamb', null, false)).toBe(true);
    expect(needsX402Verification('EDUCATION', 'waec', null, false)).toBe(false);
    expect(needsX402Verification('EDUCATION', 'waec-registration', null, false)).toBe(false);
  });

  it('requires verification for CABLE except SHOWMAX', () => {
    expect(needsX402Verification('CABLE', 'dstv', 'DSTV', false)).toBe(true);
    expect(needsX402Verification('CABLE', 'gotv', 'GOTV', false)).toBe(true);
    expect(needsX402Verification('CABLE', 'showmax', 'SHOWMAX', false)).toBe(false);
  });

  it('never requires verification for AIRTIME or DATA', () => {
    expect(needsX402Verification('AIRTIME', 'mtn', 'MTN', false)).toBe(false);
    expect(needsX402Verification('DATA', 'mtn-data', 'MTN', false)).toBe(false);
  });

  it('never requires verification for a foreign (international) payment, regardless of category', () => {
    expect(needsX402Verification('ELECTRICITY', 'ikeja-electric', null, true)).toBe(false);
    expect(needsX402Verification('BANK', 'moniepoint-transfer', 'moniepoint', true)).toBe(false);
  });

  it('defaults to false for an unrecognized category rather than guessing', () => {
    expect(needsX402Verification('UNKNOWN', 'whatever', null, false)).toBe(false);
    expect(needsX402Verification(null, null, null, false)).toBe(false);
  });
});
