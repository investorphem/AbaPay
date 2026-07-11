import { describe, it, expect } from 'vitest';
import { hashPin, verifyPin, isHashedPin } from '@/utils/pinSecurity';

describe('pinSecurity', () => {
  describe('hashPin', () => {
    it('produces a scrypt-prefixed hash, never the plaintext', () => {
      const hash = hashPin('1234');
      expect(hash).toMatch(/^scrypt\$/);
      expect(hash).not.toContain('1234');
    });

    it('produces a different hash each time (unique salt per PIN)', () => {
      // Critical: identical PINs must NOT produce identical hashes, otherwise an
      // attacker with DB read access could see which users share a PIN.
      expect(hashPin('1234')).not.toEqual(hashPin('1234'));
    });
  });

  describe('verifyPin', () => {
    it('accepts the correct PIN against its hash', () => {
      expect(verifyPin('1234', hashPin('1234'))).toBe(true);
    });

    it('rejects an incorrect PIN', () => {
      expect(verifyPin('9999', hashPin('1234'))).toBe(false);
    });

    it('rejects a PIN that is a prefix of the real one', () => {
      expect(verifyPin('123', hashPin('1234'))).toBe(false);
    });

    it('rejects empty input', () => {
      expect(verifyPin('', hashPin('1234'))).toBe(false);
    });

    it('does not throw on a malformed stored value', () => {
      expect(() => verifyPin('1234', 'scrypt$garbage')).not.toThrow();
      expect(verifyPin('1234', 'scrypt$garbage')).toBe(false);
    });

    // Legacy migration path: PINs used to be stored as plaintext.
    it('still verifies a legacy plaintext PIN (so users are not locked out)', () => {
      expect(verifyPin('1234', '1234')).toBe(true);
    });

    it('rejects a wrong PIN against a legacy plaintext value', () => {
      expect(verifyPin('0000', '1234')).toBe(false);
    });
  });

  describe('isHashedPin', () => {
    it('detects hashed vs legacy plaintext, so migration only triggers when needed', () => {
      expect(isHashedPin(hashPin('1234'))).toBe(true);
      expect(isHashedPin('1234')).toBe(false);
    });
  });
});
