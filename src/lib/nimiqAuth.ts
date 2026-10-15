import 'server-only';
import { createHash, createPublicKey, verify } from 'crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { canonicalNimAddress, isNimAddress } from '@/lib/nimiq';

// ⚡ PROVING A NIMIQ ADDRESS — for reads that must be scoped to the person asking (the NIM mini
// app's order history: phone and meter numbers, meter tokens and exam PINs are private).
//
// The caller signs a short message in Nimiq Pay (`nimiq.sign`). The server checks two things,
// and both are needed:
//   1. the Ed25519 signature is valid for that public key over Nimiq's signed-message digest,
//      SHA-256(0x16 "Nimiq Signed Message:\n" ‖ byteLength ‖ message), the construction in
//      core-rs-albatross wallet/src/wallet_account.rs;
//   2. the public key IS the address the message names: a Nimiq address is the first 20 bytes of
//      Blake2b-256(publicKey). Without this, anyone could sign with their own key and name
//      someone else's address.
//
// Read-only by construction, like /api/history's wallet session: nothing that writes accepts it.

const PREFIX = '\x16Nimiq Signed Message:\n';
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY';
/** DER header that turns a raw 32-byte Ed25519 key into SPKI, which Node's crypto accepts. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** How long a signed history message stays usable, so the app doesn't ask for a signature on every view. */
export const NIM_SESSION_MAX_AGE_MS = 24 * 3600_000;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of bytes) {
    val = ((val << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(val << (5 - bits)) & 31];
  return out;
}

function mod97(s: string): number {
  let r = 0;
  for (const c of s) {
    const d = /\d/.test(c) ? c : String(c.charCodeAt(0) - 55);
    for (const x of d) r = (r * 10 + Number(x)) % 97;
  }
  return r;
}

/** The canonical (no spaces) Nimiq address for a raw 32-byte Ed25519 public key. */
export function addressFromPublicKey(publicKeyHex: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return null;
  const body = base32(blake2b(Buffer.from(publicKeyHex, 'hex'), { dkLen: 32 }).slice(0, 20));
  const check = String(98 - mod97(`${body}NQ00`)).padStart(2, '0');
  return `NQ${check}${body}`;
}

/** Is `signatureHex` a valid Nimiq-Pay signature of `message` by `publicKeyHex`? Never throws. */
export function verifyNimSignedMessage(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
    const body = Buffer.from(message, 'utf8');
    const digest = createHash('sha256').update(Buffer.concat([Buffer.from(PREFIX + String(body.length), 'utf8'), body])).digest();
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, digest, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** The message the mini app asks Nimiq Pay to sign. One line per field, so it reads clearly in the prompt. */
export function nimHistoryMessage(address: string, issuedAt: string): string {
  return `AbaPay: show my order history\nAddress: ${canonicalNimAddress(address)}\nIssued: ${issuedAt}`;
}

export type NimSession = { ok: true; address: string } | { ok: false; message: string };

/** Checks a signed history message: valid signature, key matches the address it names, recent enough. */
export function verifyNimSession(p: { message?: unknown; signature?: unknown; publicKey?: unknown }, now = Date.now()): NimSession {
  const message = String(p.message ?? '');
  const signature = String(p.signature ?? '').replace(/^0x/i, '');
  const publicKey = String(p.publicKey ?? '').replace(/^0x/i, '');
  const m = /^AbaPay: show my order history\nAddress: (NQ[0-9A-Z]{34})\nIssued: (\S+)$/.exec(message);
  if (!m || !isNimAddress(m[1])) return { ok: false, message: 'Unrecognised sign-in message.' };
  const issued = Date.parse(m[2]);
  if (!Number.isFinite(issued) || issued > now + 5 * 60_000 || now - issued > NIM_SESSION_MAX_AGE_MS) {
    return { ok: false, message: 'This sign-in has expired. Please sign again.' };
  }
  if (addressFromPublicKey(publicKey) !== m[1]) return { ok: false, message: 'The signing key does not belong to that address.' };
  if (!verifyNimSignedMessage(message, signature, publicKey)) return { ok: false, message: 'Invalid signature.' };
  return { ok: true, address: m[1] };
}
