import { describe, it, expect } from 'vitest';
import { sigFingerprint } from '@/lib/redact';

describe('sigFingerprint', () => {
  it('keeps only enough of a signature to match the server log', () => {
    const sig = '0x' + 'ab'.repeat(65);
    const fp = sigFingerprint(sig);
    expect(fp).toBe(`${sig.slice(0, 10)}…${sig.slice(-6)}`);
    expect(fp.length).toBeLessThan(20);
    expect(fp).not.toContain(sig.slice(10, -6));
  });

  it('never echoes a short value, and labels a missing one', () => {
    expect(sigFingerprint('123456')).toBe('[redacted]');
    expect(sigFingerprint('')).toBe('n/a');
    expect(sigFingerprint(undefined)).toBe('n/a');
  });
});
