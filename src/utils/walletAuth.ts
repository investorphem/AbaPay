import 'server-only';
import { verifyMessage as verifyMessageEOA } from 'viem';
import { verifyMessage as verifyMessageOnChain } from 'viem/actions';
import { parseSiweMessage } from 'viem/siwe';
import { getPublicClient } from '@/lib/chain';
import { supabaseAdmin } from '@/utils/supabase';
import { walletSessionMessage, WALLET_SESSION_MAX_AGE_MS } from '@/lib/walletSession';
import {
  SIWE_HEADER, SIWE_ACTION_LIFETIME_MS, SIWE_SESSION_LIFETIME_MS, SIWE_SESSION_RESOURCE, siweActionResource,
} from '@/lib/siwe';

// 🔐 SIWE FIRST, LEGACY UNTIL A CUT-OFF (M4.4).
//
// Both verifiers below accept a Sign-In with Ethereum proof (src/lib/siwe.ts) whenever one is
// sent, and check it properly: our domain, unexpired, bound to this exact action, a valid
// signature (EOA or smart wallet), and a single-use nonce consumed atomically.
//
// The old bare-string format is still accepted so already-published SDKs and copied quickstart
// code keep working, but ONLY until LEGACY_WALLET_SIG_ACCEPT_UNTIL (default below). Every legacy
// use is logged, so the cut-off can be judged from real traffic. To extend it, set the env var.
const LEGACY_DEFAULT_UNTIL = '2026-10-31T00:00:00Z';

export function legacySignaturesAccepted(now = Date.now()): boolean {
  const until = Date.parse(process.env.LEGACY_WALLET_SIG_ACCEPT_UNTIL || LEGACY_DEFAULT_UNTIL);
  return Number.isFinite(until) ? now < until : false;
}

const DEFAULT_SIWE_DOMAINS = ['abapays.com', 'www.abapays.com', 'agents.abapays.com', 'rails.abapays.com'];

/** Our own hosts, plus this project's Vercel previews and localhost outside production. */
export function siweDomainAllowed(domain: string): boolean {
  const host = String(domain || '').toLowerCase();
  const configured = (process.env.SIWE_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if ([...DEFAULT_SIWE_DOMAINS, ...configured].includes(host)) return true;
  if (/^abapay[a-z0-9-]*\.vercel\.app$/.test(host)) return true;
  if (process.env.VERCEL_ENV !== 'production' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
  return false;
}

type Verified = { ok: true; address: string } | { ok: false; message: string };

/**
 * Verify a SIWE proof if the request carries one; null when it doesn't (caller falls back to
 * the legacy check, while that's still allowed).
 */
export async function verifySiweProof(
  req: Request,
  opts: { purpose: 'action' | 'session'; action?: string; expectedAddress?: string },
): Promise<Verified | null> {
  const encoded = req.headers.get(SIWE_HEADER);
  if (!encoded) return null;
  const signature = req.headers.get('x-wallet-signature') || '';

  let raw: string;
  try { raw = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return { ok: false, message: 'Malformed sign-in message.' }; }
  let msg: ReturnType<typeof parseSiweMessage>;
  try { msg = parseSiweMessage(raw); } catch { return { ok: false, message: 'Malformed sign-in message.' }; }

  const address = String(msg.address || '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return { ok: false, message: 'Sign-in message has no valid address.' };
  if (opts.expectedAddress && address.toLowerCase() !== opts.expectedAddress.toLowerCase()) {
    return { ok: false, message: 'This signature is for a different wallet.' };
  }
  if (!siweDomainAllowed(msg.domain || '')) return { ok: false, message: 'This signature was made for a different website.' };

  const resource = opts.purpose === 'session' ? SIWE_SESSION_RESOURCE : siweActionResource(opts.action || '');
  if (!msg.resources?.includes(resource)) return { ok: false, message: 'This signature was made for a different action.' };

  const now = Date.now();
  const issued = msg.issuedAt ? new Date(msg.issuedAt).getTime() : NaN;
  const expires = msg.expirationTime ? new Date(msg.expirationTime).getTime() : NaN;
  const maxLife = opts.purpose === 'session' ? SIWE_SESSION_LIFETIME_MS : SIWE_ACTION_LIFETIME_MS;
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false, message: 'Sign-in message must carry issue and expiry times.' };
  if (issued > now + 60_000 || expires <= now || expires - issued > maxLife + 60_000) {
    return { ok: false, message: 'Signature expired — please try again.' };
  }
  if (msg.notBefore && new Date(msg.notBefore).getTime() > now + 60_000) return { ok: false, message: 'Signature is not valid yet.' };
  if (!msg.nonce) return { ok: false, message: 'Sign-in message has no nonce.' };

  if (!signature || !(await verifySignatureAcrossChains(address, raw, signature))) {
    return { ok: false, message: 'Invalid signature — could not verify wallet ownership.' };
  }

  // Last, so a bad signature can't spend someone's nonce: claim (or, for a session, check) it.
  const { data: fresh, error } = await supabaseAdmin.rpc('consume_auth_nonce', { p_nonce: msg.nonce, p_purpose: opts.purpose });
  if (error) {
    console.error('[walletAuth] nonce check failed:', error.message);
    return { ok: false, message: 'Could not verify the signature right now — please try again.' };
  }
  if (fresh !== true) return { ok: false, message: 'This signature was already used or has expired — please try again.' };

  return { ok: true, address };
}

// 🔐 WALLET OWNERSHIP PROOF
//
// THE VULNERABILITY THIS CLOSES: /api/agent/link (create a link + PIN, change/reset a PIN,
// unlink) and /api/schedules (create an autonomous payment schedule) all accepted a bare
// `wallet_address` string in the JSON body, with nothing proving the caller actually
// controls that wallet. A wallet address is PUBLIC data — visible on-chain, in receipts, in
// transaction history — so anyone who knew a target's address could call these endpoints
// directly (curl, not the UI) and act as if they owned it. Concretely: an attacker could
// POST their OWN Telegram/WhatsApp chat id + a PIN THEY chose against a VICTIM's wallet
// address, then later spend from whatever on-chain allowance the real owner approves for
// that wallet — the relayer/contract only check the wallet address, not who's chatting.
//
// FIX: every wallet-scoped mutation must carry a signature, freshly produced by that same
// wallet, over a short-lived timestamped message — proving the caller holds the private key
// RIGHT NOW, not just that they know the public address. This mirrors src/utils/adminAuth.ts
// exactly, but for any wallet (not just the contract owner) and scoped to a single action
// (5 min) rather than a long admin session, since these are one-off clicks, not a dashboard.
//
// 🔴 SECOND VULNERABILITY THIS CLOSES: the signed message used to be a bare
// `AbaPay Agent Action: <timestamp>` — identical no matter which action it authorized. That
// meant ANY signature obtained under this exact wording (e.g. via a phishing site cloning the
// framing "sign to verify your wallet") could be replayed within the 5-minute window against
// ANY of these endpoints — a signature the victim believed was for one thing could create a
// link, reset a PIN, or unlink, with attacker-chosen parameters. The message now binds to
// `METHOD:PATH`, so a signature is only ever valid for the specific endpoint it was produced
// for — a phished signature intended (or framed) for one action can't be repurposed for a
// different one.
//
// NOT bound to the full request body: /api/schedules' POST deliberately reuses ONE signature
// across several fetch calls for a multi-recipient batch (see AIChat.tsx's approveSchedule —
// "one signature covers the whole Approve click, even for a multi-recipient batch"), each with
// a different body. Binding to method+path closes the cross-endpoint confusion attack without
// breaking that batching UX. A same-endpoint-different-body replay is a narrower residual risk,
// worth closing with per-field binding as a follow-up if this needs to be airtight.

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export function walletAuthMessage(timestamp: string, action: string): string {
  return `AbaPay Agent Action: ${action}: ${timestamp}`;
}

// 🔐 SMART-WALLET-AWARE SIGNATURE CHECK — shared by every wallet-signature gate in the app
// (this file, src/utils/adminAuth.ts, and the discount-campaign step-up confirmation in
// src/app/api/admin/discounts/route.ts).
//
// 🔴 THE BUG THIS FIXES: a plain ECDSA `ecrecover`-based check (viem's standalone
// `verifyMessage`) can ONLY ever validate an externally-owned account's signature. A smart
// contract wallet — Coinbase Smart Wallet / Base Account (Base's own headline wallet
// experience, see the "Sponsored Gas on Base" feature in the README), Safe, etc. — doesn't
// sign with a raw private key the same way; `ecrecover` on its signature just recovers some
// unrelated address, so the plain check fails 100% of the time, for every action gated by
// it, for every smart-wallet user. The only correct way to validate that signature is to ask
// the wallet's own contract via ERC-1271 (or ERC-6492 for a counterfactual/undeployed one),
// which requires a real RPC call against whichever chain the contract lives on.
export async function verifySignatureAcrossChains(address: string, message: string, signature: string): Promise<boolean> {
  // Fast path: plain ECDSA recovery, no RPC call — covers the common case (MetaMask,
  // Valora, WalletConnect, MiniPay: all externally-owned accounts).
  try {
    const valid = await verifyMessageEOA({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
    if (valid) return true;
  } catch { /* fall through to the on-chain check below */ }

  // Not told which chain the wallet is connected to here, so try both chains AbaPay runs on
  // rather than rejecting outright.
  for (const chain of ['BASE', 'CELO']) {
    try {
      const client = getPublicClient(chain);
      const valid = await verifyMessageOnChain(client, { address: address as `0x${string}`, message, signature: signature as `0x${string}` });
      if (valid) return true;
    } catch { /* try the other chain */ }
  }

  return false;
}

// 🔐 WALLET SESSION — PROOF OF OWNERSHIP FOR READING YOUR OWN DATA
//
// Separate from the action signatures above, and deliberately so. Those authorise a single
// MUTATION and last five minutes. This one authorises READS of the caller's own records for a
// browsing session, because the alternative is a wallet prompt every time the History tab
// refreshes — which trains people to sign whatever they are shown, the exact habit that makes
// phishing work.
//
// ⚠️ WHAT THIS IS, HONESTLY: for its lifetime this is a bearer token. Anyone holding the header
// triple can replay it to read that wallet's history until it expires. That is the same trade
// src/utils/adminAuth.ts already makes for the admin dashboard, and it is acceptable HERE only
// because the scope is read-only and limited to records the wallet owner can already see. It
// must never be widened to authorise a mutation — those keep their own five-minute, per-action
// signatures.
// Both come from src/lib/walletSession.ts, which carries no `server-only` marker so the BROWSER
// can import the exact same message builder it signs with. Defining it twice would mean a stray
// character silently invalidating every signature, reported as "invalid signature".

/**
 * Verify a wallet-session proof carried in headers. Read paths only — see the note above.
 *
 * Returns the verified address rather than a bare boolean, so a caller cannot accidentally query
 * on an address it never actually checked.
 */
export async function verifyWalletSession(req: Request): Promise<{ ok: true; address: string } | { ok: false; message: string }> {
  const siwe = await verifySiweProof(req, { purpose: 'session' });
  if (siwe) return siwe;
  if (!legacySignaturesAccepted()) {
    return { ok: false, message: 'Please sign in again — this app version uses an outdated sign-in. Refresh the page.' };
  }

  const address = req.headers.get('x-wallet-address');
  const signature = req.headers.get('x-wallet-signature');
  const timestamp = req.headers.get('x-wallet-timestamp');

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, message: 'Valid wallet address required.' };
  }
  if (!signature || !timestamp) {
    return { ok: false, message: 'Missing wallet signature — reconnect your wallet and try again.' };
  }

  const ts = parseInt(timestamp, 10);
  // The future bound matters as much as the past one: without it a signature timestamped years
  // ahead would never expire.
  if (!Number.isFinite(ts) || Date.now() - ts > WALLET_SESSION_MAX_AGE_MS || ts > Date.now() + 60_000) {
    return { ok: false, message: 'Wallet session expired — reconnect your wallet.' };
  }

  const valid = await verifySignatureAcrossChains(address, walletSessionMessage(timestamp), signature);
  if (!valid) return { ok: false, message: 'Invalid signature — could not verify wallet ownership.' };

  console.warn(`[walletAuth] legacy session signature accepted for ${address} (refused after ${process.env.LEGACY_WALLET_SIG_ACCEPT_UNTIL || LEGACY_DEFAULT_UNTIL})`);
  return { ok: true, address };
}

export async function verifyWalletOwnership(req: Request, claimedWallet: string, action: string): Promise<{ ok: boolean; message?: string }> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(claimedWallet)) {
    return { ok: false, message: 'Valid wallet address required.' };
  }

  const siwe = await verifySiweProof(req, { purpose: 'action', action, expectedAddress: claimedWallet });
  if (siwe) return siwe.ok ? { ok: true } : { ok: false, message: siwe.message };
  if (!legacySignaturesAccepted()) {
    return { ok: false, message: 'This signature format is no longer accepted. Update the AbaPay app or SDK (sign-in now uses EIP-4361).' };
  }

  const signature = req.headers.get('x-wallet-signature');
  const timestamp = req.headers.get('x-wallet-timestamp');
  if (!signature || !timestamp) {
    return { ok: false, message: 'Missing wallet signature — please try again from the app.' };
  }

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Date.now() - ts > MAX_SIGNATURE_AGE_MS || ts > Date.now() + 60_000) {
    return { ok: false, message: 'Signature expired — please try again.' };
  }

  const valid = await verifySignatureAcrossChains(claimedWallet, walletAuthMessage(timestamp, action), signature);
  if (!valid) return { ok: false, message: 'Invalid signature — could not verify wallet ownership.' };

  console.warn(`[walletAuth] legacy action signature accepted: ${action} for ${claimedWallet} (refused after ${process.env.LEGACY_WALLET_SIG_ACCEPT_UNTIL || LEGACY_DEFAULT_UNTIL})`);
  return { ok: true };
}
