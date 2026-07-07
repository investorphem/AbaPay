import crypto from 'crypto';

// 🔐 PIN HASHING (scrypt, no external dependencies)
//
// DeAI PINs were previously stored in plaintext — anyone with database read
// access (a leaked backup, an over-permissive dashboard user, a compromised
// service key) could see every user's transaction PIN. PINs are now stored as
// salted scrypt hashes in the format:  scrypt$<saltHex>$<hashHex>
//
// Legacy plaintext PINs are transparently upgraded: on the next successful
// verification the stored value is replaced with a hash (see deai/core).

const SCRYPT_PREFIX = 'scrypt$';
const KEY_LEN = 32;

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin.normalize(), salt, KEY_LEN);
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function isHashedPin(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(SCRYPT_PREFIX);
}

export function verifyPin(pin: string, stored: string): boolean {
  try {
    if (isHashedPin(stored)) {
      const [, saltHex, hashHex] = stored.split('$');
      if (!saltHex || !hashHex) return false;
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(pin.normalize(), Buffer.from(saltHex, 'hex'), expected.length);
      return crypto.timingSafeEqual(actual, expected);
    }
    // Legacy plaintext comparison — still timing-safe, caller should upgrade the record on success.
    const a = Buffer.from(pin.normalize());
    const b = Buffer.from(String(stored).normalize());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
