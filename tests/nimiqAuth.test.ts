import { describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'crypto';

// ⚡ PROVING A NIMIQ ADDRESS (src/lib/nimiqAuth.ts) — what scopes the NIM order history.
// The ATTACK case is the one the address check exists for: a valid signature made with the
// attacker's own key over a message naming someone else's address.

vi.mock('server-only', () => ({}));

const { addressFromPublicKey, nimHistoryMessage, verifyNimSession, verifyNimSignedMessage } = await import('@/lib/nimiqAuth');

/** A Nimiq-Pay-style key pair and signer: Ed25519 over SHA-256 of Nimiq's signed-message envelope. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex');
  const signMessage = (message: string) => {
    const body = Buffer.from(message, 'utf8');
    const digest = createHash('sha256').update(Buffer.concat([Buffer.from(`\x16Nimiq Signed Message:\n${body.length}`, 'utf8'), body])).digest();
    return sign(null, digest, privateKey).toString('hex');
  };
  return { pub, address: addressFromPublicKey(pub)!, signMessage };
}

describe('addressFromPublicKey', () => {
  it('matches a real mainnet sender (public key read from its transaction proof)', () => {
    expect(addressFromPublicKey('4b93586f7555e72b218bb522d66bf52d9c38b8396bd8bfd45c99c3c282c53ba1')).toBe('NQ162SSN82TLSMQSKXT3Q01VCMALNU6F1LJG');
  });

  it('rejects anything that is not a 32-byte hex key', () => {
    expect(addressFromPublicKey('abc')).toBeNull();
  });
});

describe('verifyNimSession', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const issued = new Date(now - 60_000).toISOString();

  it('accepts a fresh message signed by the address it names', () => {
    const w = wallet();
    const message = nimHistoryMessage(w.address, issued);
    expect(verifyNimSession({ message, signature: w.signMessage(message), publicKey: w.pub }, now)).toEqual({ ok: true, address: w.address });
  });

  it('ATTACK: a valid signature by one wallet naming another wallet’s address is refused', () => {
    const attacker = wallet();
    const victim = wallet();
    const message = nimHistoryMessage(victim.address, issued);
    expect(verifyNimSession({ message, signature: attacker.signMessage(message), publicKey: attacker.pub }, now)).toMatchObject({ ok: false });
  });

  it('refuses a tampered message, an expired one and a malformed one', () => {
    const w = wallet();
    const message = nimHistoryMessage(w.address, issued);
    const signature = w.signMessage(message);
    expect(verifyNimSession({ message: message.replace(issued, new Date(now).toISOString()), signature, publicKey: w.pub }, now).ok).toBe(false);
    const old = nimHistoryMessage(w.address, new Date(now - 25 * 3600_000).toISOString());
    expect(verifyNimSession({ message: old, signature: w.signMessage(old), publicKey: w.pub }, now)).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) });
    expect(verifyNimSession({ message: 'hello', signature, publicKey: w.pub }, now).ok).toBe(false);
  });

  it('never throws on garbage input', () => {
    expect(verifyNimSignedMessage('x', 'zz', 'zz')).toBe(false);
    expect(verifyNimSession({}, now).ok).toBe(false);
  });
});
