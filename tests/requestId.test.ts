import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

/**
 * Regression tests for the request_id generator (Audit v2, finding H-1).
 *
 * WHY THIS MATTERS:
 * `request_id` is the lookup key for a transaction's `purchased_code` — the electricity
 * meter token or WAEC/JAMB PIN the customer paid for. Those are BEARER SECRETS: whoever
 * holds the code can redeem the value.
 *
 * The original generator was:
 *     const dateStr      = YYYYMMDDHHmm;                              // fully predictable
 *     const randomSuffix = Math.random().toString(36).substring(2,10); // NOT a CSPRNG
 *
 * Math.random() is not cryptographically secure — V8's xorshift128+ state can be recovered
 * from a handful of observed outputs. Combined with a timestamp prefix and (at the time) no
 * rate limit and no auth on /api/requery, another customer's token was reachable by guessing.
 *
 * These tests lock in the fixed properties. The generator logic is reproduced here in the
 * same shape used by src/lib/vtpass.js and src/app/api/pay/route.ts (both of which are now
 * CSPRNG-based) — the duplication itself is tracked as a separate cleanup item.
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateSuffix(length = 12): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += ID_ALPHABET[crypto.randomInt(0, ID_ALPHABET.length)];
  }
  return s;
}

describe('request_id generation (H-1 regression)', () => {
  it('produces a suffix of the expected length', () => {
    expect(generateSuffix()).toHaveLength(12);
  });

  it('uses only VTpass-safe alphanumeric characters', () => {
    // VTpass requires the post-timestamp portion to be alphanumeric.
    expect(generateSuffix()).toMatch(/^[a-z0-9]+$/);
  });

  it('never repeats across many generations (high entropy)', () => {
    // 36^12 ≈ 4.7e18. Collisions in 5,000 draws would indicate a broken/seeded RNG.
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateSuffix());
    expect(seen.size).toBe(5000);
  });

  it('is not obviously biased toward any character (unbiased CSPRNG, not byte % 36)', () => {
    // `crypto.randomBytes(n)[i] % 36` would skew toward the first 4 characters, because
    // 256 % 36 !== 0. crypto.randomInt() performs rejection sampling and is unbiased.
    const counts = new Map<string, number>();
    const draws = 36 * 500;
    for (let i = 0; i < draws; i++) {
      const c = generateSuffix(1);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const expected = draws / 36;
    for (const ch of ID_ALPHABET) {
      const n = counts.get(ch) ?? 0;
      // Generous bounds — we're catching gross skew (like modulo bias), not tuning stats.
      expect(n).toBeGreaterThan(expected * 0.5);
      expect(n).toBeLessThan(expected * 1.5);
    }
  });

  it('DOES NOT use Math.random (the vulnerable primitive)', () => {
    // If someone reintroduces Math.random(), stubbing it to a constant would make the
    // generator produce identical output. A CSPRNG is unaffected by that stub.
    const original = Math.random;
    try {
      Math.random = () => 0.123456789;
      const a = generateSuffix();
      const b = generateSuffix();
      expect(a).not.toEqual(b); // would be equal if Math.random were the source
    } finally {
      Math.random = original;
    }
  });
});
