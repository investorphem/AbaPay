import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';

// 🔐 SIGN-IN WITH ETHEREUM (EIP-4361) — ONE DEFINITION, BOTH SIDES.
//
// Every wallet-ownership proof (a mutation like linking an agent or creating a schedule, and the
// read-only session the History tab and assistant use) is a SIWE message. Unlike the old
// "AbaPay Agent Action: <METHOD:PATH>: <ts>" string, it:
//   • names the website (`domain`): wallets warn when it doesn't match the site asking, so a
//     phishing page can no longer collect a signature that works here;
//   • carries a single-use nonce from GET /api/auth/nonce: a captured signature can't be replayed;
//   • says, in a sentence the person reads in their wallet, what they're approving (`statement`),
//     and binds it to exactly one action (`resources`).
//
// No `server-only` marker: the browser builds messages with the same code the server checks
// them against (src/utils/walletAuth.ts).

/** Header carrying the SIWE message, base64-encoded (a header can't hold its newlines). */
export const SIWE_HEADER = 'x-wallet-siwe';

/** An action proof is good for 5 minutes; a read-only session for 12 hours. */
export const SIWE_ACTION_LIFETIME_MS = 5 * 60 * 1000;
export const SIWE_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** The resource a proof is bound to. Actions are "METHOD:/api/path". */
export const siweActionResource = (action: string) => `abapay:action:${action}`;
export const SIWE_SESSION_RESOURCE = 'abapay:session';

/** What the person reads in their wallet. ASCII only (EIP-4361 requires it). */
const ACTION_STATEMENTS: Record<string, string> = {
  'POST:/api/agent/link': 'Link an AI agent or chat account to this wallet, protected by the PIN you chose.',
  'PATCH:/api/agent/link': 'Change the PIN for an agent linked to this wallet.',
  'DELETE:/api/agent/link': 'Unlink an agent from this wallet.',
  'GET:/api/schedules': 'Show the automations set up for this wallet.',
  'POST:/api/schedules': 'Create an automated bill payment for this wallet.',
  'DELETE:/api/schedules': 'Cancel an automated bill payment for this wallet.',
};

export function siweStatement(purpose: 'action' | 'session', action?: string): string {
  if (purpose === 'session') {
    return 'Sign in to AbaPay. This proves you control this wallet and starts a read-only session. It does NOT approve any payment, transfer, or spending permission.';
  }
  return `${ACTION_STATEMENTS[action || ''] || 'Confirm this action for your wallet.'} It does not move any money by itself.`;
}

export interface BuildSiweParams {
  purpose: 'action' | 'session';
  action?: string;
  address: string;
  chainId: number;
  nonce: string;
  domain: string;   // host, e.g. "abapays.com"
  uri: string;      // origin, e.g. "https://abapays.com"
  now?: Date;
}

export function buildSiweMessage(p: BuildSiweParams): string {
  const now = p.now ?? new Date();
  const lifetime = p.purpose === 'session' ? SIWE_SESSION_LIFETIME_MS : SIWE_ACTION_LIFETIME_MS;
  return createSiweMessage({
    domain: p.domain,
    uri: p.uri,
    address: getAddress(p.address),
    chainId: p.chainId,
    nonce: p.nonce,
    version: '1',
    issuedAt: now,
    expirationTime: new Date(now.getTime() + lifetime),
    statement: siweStatement(p.purpose, p.action),
    resources: [p.purpose === 'session' ? SIWE_SESSION_RESOURCE : siweActionResource(p.action || '')],
  });
}

/** EIP-155 chain id for the message. Informational (the server doesn't require a particular
 *  chain), but wallets display it, so it should match where the user is. */
export function siweChainId(chainName?: string | null): number {
  const mainnet = ['mainnet', 'celo', 'base'].includes(String(process.env.NEXT_PUBLIC_NETWORK || ''));
  return String(chainName || '').toUpperCase() === 'CELO'
    ? (mainnet ? 42220 : 11142220)
    : (mainnet ? 8453 : 84532);
}

/** base64 of an ASCII SIWE message, for the header. */
export function encodeSiweHeader(message: string): string {
  return typeof btoa === 'function' ? btoa(message) : Buffer.from(message, 'utf8').toString('base64');
}

/**
 * Browser helper: fetch a nonce, build the SIWE message for this site, have the wallet sign it,
 * and return the headers to send. `uses` > 1 lets one signature cover a batch of identical
 * requests (e.g. N schedule POSTs from one Approve click).
 */
export async function signSiweHeaders(opts: {
  purpose: 'action' | 'session';
  action?: string;
  address: string;
  chainId: number;
  sign: (message: string) => Promise<string>;
  uses?: number;
}): Promise<Record<string, string>> {
  const q = new URLSearchParams({ purpose: opts.purpose, ...(opts.uses && opts.uses > 1 ? { uses: String(opts.uses) } : {}) });
  const res = await fetch(`/api/auth/nonce?${q}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.nonce) throw new Error(data?.message || 'Could not start wallet verification. Please try again.');
  const message = buildSiweMessage({
    purpose: opts.purpose,
    action: opts.action,
    address: opts.address,
    chainId: opts.chainId,
    nonce: data.nonce,
    domain: window.location.host,
    uri: window.location.origin,
  });
  const signature = await opts.sign(message);
  return { 'x-wallet-address': opts.address, 'x-wallet-signature': signature, [SIWE_HEADER]: encodeSiweHeader(message) };
}
