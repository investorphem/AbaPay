import 'server-only';
import { verifyMessage as verifyMessageEOA } from 'viem';
import { verifyMessage as verifyMessageOnChain } from 'viem/actions';
import { getPublicClient } from '@/lib/chain';

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

export async function verifyWalletOwnership(req: Request, claimedWallet: string, action: string): Promise<{ ok: boolean; message?: string }> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(claimedWallet)) {
    return { ok: false, message: 'Valid wallet address required.' };
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

  return { ok: true };
}
