import 'server-only';
import { verifyMessage } from 'viem';

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

  try {
    const valid = await verifyMessage({
      address: claimedWallet as `0x${string}`,
      message: walletAuthMessage(timestamp, action),
      signature: signature as `0x${string}`,
    });
    if (!valid) return { ok: false, message: 'Invalid signature — could not verify wallet ownership.' };
  } catch {
    return { ok: false, message: 'Signature verification failed.' };
  }

  return { ok: true };
}
