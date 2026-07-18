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

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export function walletAuthMessage(timestamp: string): string {
  return `AbaPay Agent Action: ${timestamp}`;
}

export async function verifyWalletOwnership(req: Request, claimedWallet: string): Promise<{ ok: boolean; message?: string }> {
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
      message: walletAuthMessage(timestamp),
      signature: signature as `0x${string}`,
    });
    if (!valid) return { ok: false, message: 'Invalid signature — could not verify wallet ownership.' };
  } catch {
    return { ok: false, message: 'Signature verification failed.' };
  }

  return { ok: true };
}
