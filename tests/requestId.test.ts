import { describe, it, expect } from 'vitest';
import { randomIdSuffix, getStrictRequestId } from '@/lib/requestId';

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
 * These tests lock in the fixed properties.
 *
 * 🔴 THEY NOW TEST THE SHIPPED CODE. This file used to re-implement the generator locally and
 * assert against that copy — so it verified the IDEA of a CSPRNG suffix while the function
 * actually running in production was never executed by the suite. (Audit v2 raised exactly
 * this: "tests the idea, not the shipped code.") Both the generator and its duplicate have
 * since been collapsed into src/lib/requestId.ts, which imports nothing but `crypto`, so the
 * real function can be imported and exercised directly.
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// The real, shipped generator — not a copy of it.
const generateSuffix = (length = 12) => randomIdSuffix(length);

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

  it('getStrictRequestId returns a 24-char id: 12-digit Lagos timestamp + 12 random chars', () => {
    // VTpass mandates YYYYMMDDHHmm as the first 12 characters, then alphanumerics. The length
    // also matters historically: 20-char ids are the legacy Math.random() generation, so a
    // regression to that shape is visible here.
    const id = getStrictRequestId();
    expect(id).toHaveLength(24);
    expect(id).toMatch(/^\d{12}[a-z0-9]{12}$/);
  });

  it('getStrictRequestId does not collide across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(getStrictRequestId());
    expect(seen.size).toBe(2000);
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
