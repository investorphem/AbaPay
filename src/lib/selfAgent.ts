import 'server-only';
import { keccak256, toBytes, recoverMessageAddress, pad, parseAbi, getAddress, isAddress } from 'viem';
import { getPublicClient, isMainnetEnv } from '@/lib/chain';
import { errorMessage } from '@/lib/errors';

// 🪪 SELF AGENT ID — an agent proving it is backed by a real, passport-verified human, on the
// requests it makes to AbaPay's MCP server and x402 endpoint (Prezenti grant milestone 2).
//
// Protocol (Self's agent SDK, implemented independently here): the agent signs
//   keccak256( timestamp + METHOD + path?query + keccak256(rawBody) )
// as an Ethereum personal message and sends
//   x-self-agent-address, x-self-agent-signature, x-self-agent-timestamp (ms).
// The recovered signer, zero-padded to 32 bytes, is its key on the SelfAgentRegistry, which says
// whether it is a verified agent, whether its human proof is still fresh, and which provider
// issued the proof (it must be Self's own).
//
// POLICY (docs.abapays.com → Self Agent ID): Self is optional. No headers → everything works,
// the agent is just not shown as verified. A signature that does not check out (forged, wrong
// body, stale timestamp, replayed) is REFUSED — a claimed identity that can't be proven. A valid
// signature from an agent that isn't verified / is revoked / has an expired proof still pays,
// and is shown as such. A registry we can't read never blocks a payment.

export const SELF_AGENT_REGISTRY = isMainnetEnv()
  ? '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944'
  : '0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379';

export const SELF_HEADERS = {
  address: 'x-self-agent-address',
  signature: 'x-self-agent-signature',
  timestamp: 'x-self-agent-timestamp',
  keytype: 'x-self-agent-keytype',
} as const;

const MAX_AGE_MS = 5 * 60 * 1000;

const REGISTRY_ABI = parseAbi([
  'function isVerifiedAgent(bytes32 agentPubKey) view returns (bool)',
  'function getAgentId(bytes32 agentPubKey) view returns (uint256)',
  'function hasHumanProof(uint256 agentId) view returns (bool)',
  'function isProofFresh(uint256 agentId) view returns (bool)',
  'function getProofProvider(uint256 agentId) view returns (address)',
  'function selfProofProvider() view returns (address)',
]);

/** What a request said about its Self Agent ID, and what the registry made of it. */
export type SelfAgentStatus =
  | { present: false }
  | { present: true; status: 'verified'; agentAddress: string; agentId: string }
  | { present: true; status: 'expired' | 'not_registered' | 'no_human_proof' | 'wrong_provider' | 'unavailable'; agentAddress: string; agentId?: string; detail: string }
  | { present: true; status: 'invalid'; agentAddress?: string; detail: string };

/** Path + query, exactly as the agent signed it. */
export function canonicalPathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || '/') + u.search;
  } catch {
    return url;
  }
}

/** The 32-byte digest an agent signs for a request. */
export function selfSigningDigest(timestamp: string, method: string, url: string, rawBody: string): `0x${string}` {
  const bodyHash = keccak256(toBytes(rawBody ?? ''));
  return keccak256(toBytes(timestamp + method.toUpperCase() + canonicalPathAndQuery(url) + bodyHash));
}

// A signature may be presented once within its freshness window (per server instance).
const seen = new Map<string, number>();
function replayed(signature: string, now: number): boolean {
  for (const [sig, at] of seen) if (now - at > MAX_AGE_MS) seen.delete(sig);
  if (seen.has(signature)) return true;
  seen.set(signature, now);
  return false;
}

/**
 * Check a request's Self Agent ID. `rawBody` must be the body exactly as received (read it from a
 * clone before parsing). Never throws.
 */
export async function verifySelfAgentRequest(req: Request, rawBody: string, now = Date.now()): Promise<SelfAgentStatus> {
  const claimed = req.headers.get(SELF_HEADERS.address);
  const signature = req.headers.get(SELF_HEADERS.signature);
  const timestamp = req.headers.get(SELF_HEADERS.timestamp);
  if (!claimed && !signature && !timestamp) return { present: false };
  if (!signature || !timestamp) return { present: true, status: 'invalid', detail: 'Self Agent headers are incomplete: x-self-agent-signature and x-self-agent-timestamp are both required.' };
  if ((req.headers.get(SELF_HEADERS.keytype) || '').toLowerCase() === 'ed25519') {
    return { present: true, status: 'invalid', detail: 'Ed25519 Self agent keys are not supported yet; sign with the agent’s EVM (secp256k1) key.' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_AGE_MS) {
    return { present: true, status: 'invalid', detail: 'x-self-agent-timestamp is missing, invalid or more than 5 minutes from the server clock.' };
  }

  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: { raw: selfSigningDigest(timestamp, req.method, req.url, rawBody) }, signature: signature as `0x${string}` });
  } catch {
    return { present: true, status: 'invalid', detail: 'x-self-agent-signature is not a valid signature over this request.' };
  }
  if (claimed && (!isAddress(claimed) || getAddress(claimed) !== getAddress(signer))) {
    return { present: true, status: 'invalid', agentAddress: signer, detail: 'The signature was made by a different address than x-self-agent-address.' };
  }
  if (replayed(signature, now)) {
    return { present: true, status: 'invalid', agentAddress: signer, detail: 'This Self Agent signature was already used; sign each request afresh.' };
  }

  const agentAddress = getAddress(signer);
  try {
    const client = getPublicClient('CELO');
    const key = pad(agentAddress as `0x${string}`, { size: 32 });
    const [isVerified, id] = await Promise.all([
      client.readContract({ address: SELF_AGENT_REGISTRY, abi: REGISTRY_ABI, functionName: 'isVerifiedAgent', args: [key] }),
      client.readContract({ address: SELF_AGENT_REGISTRY, abi: REGISTRY_ABI, functionName: 'getAgentId', args: [key] }),
    ]);
    if (id === BigInt(0)) return { present: true, status: 'not_registered', agentAddress, detail: 'This agent key is not on the SelfAgentRegistry (never registered, or revoked).' };
    const agentId = id.toString();
    if (!isVerified) return { present: true, status: 'not_registered', agentAddress, agentId, detail: 'This agent is no longer verified on the SelfAgentRegistry (revoked).' };
    const [human, fresh, provider, selfProvider] = await Promise.all([
      client.readContract({ address: SELF_AGENT_REGISTRY, abi: REGISTRY_ABI, functionName: 'hasHumanProof', args: [id] }),
      client.readContract({ address: SELF_AGENT_REGISTRY, abi: REGISTRY_ABI, functionName: 'isProofFresh', args: [id] }),
      client.readContract({ address: SELF_AGENT_REGISTRY, abi: REGISTRY_ABI, functionName: 'getProofProvider', args: [id] }),
      client.readContract({ address: SELF_AGENT_REGISTRY, abi: REGISTRY_ABI, functionName: 'selfProofProvider' }),
    ]);
    if (!human) return { present: true, status: 'no_human_proof', agentAddress, agentId, detail: 'This agent is registered without a human proof.' };
    if (String(provider).toLowerCase() !== String(selfProvider).toLowerCase()) {
      return { present: true, status: 'wrong_provider', agentAddress, agentId, detail: 'This agent’s proof was not issued by Self Protocol’s own provider.' };
    }
    if (!fresh) return { present: true, status: 'expired', agentAddress, agentId, detail: 'This agent’s human proof has expired; the owner can re-verify at https://app.ai.self.xyz.' };
    return { present: true, status: 'verified', agentAddress, agentId };
  } catch (e) {
    return { present: true, status: 'unavailable', agentAddress, detail: `The SelfAgentRegistry could not be read: ${errorMessage(e).slice(0, 120)}` };
  }
}

/** The compact form attached to responses and recorded with the payment. */
export function selfAgentSummary(s: SelfAgentStatus): Record<string, unknown> | null {
  if (!s.present) return null;
  return { status: s.status, ...('agentAddress' in s && s.agentAddress ? { agent_address: s.agentAddress } : {}), ...('agentId' in s && s.agentId ? { agent_id: s.agentId } : {}), ...('detail' in s ? { detail: s.detail } : {}) };
}

/** Response header value, e.g. "verified; agent_id=12". */
export function selfAgentHeader(s: SelfAgentStatus): string | null {
  if (!s.present) return null;
  return `${s.status}${'agentId' in s && s.agentId ? `; agent_id=${s.agentId}` : ''}`;
}

// The status of the request being handled, so the payment recorder (src/lib/payerIdentity.ts)
// can store it with the payment without threading it through every call.
const byRequest = new WeakMap<Request, SelfAgentStatus>();
export function rememberSelfAgent(req: Request, s: SelfAgentStatus) { byRequest.set(req, s); }
export function selfAgentFor(req: Request): SelfAgentStatus | undefined { return byRequest.get(req); }

/**
 * Wrap a route handler: verify the Self Agent ID on the raw body, refuse a signature that doesn't
 * check out, and decorate the response with the result (header always; `self_agent` on JSON
 * objects; for JSON-RPC, on result._meta). `invalid` gets `refuse(detail)`.
 */
export async function withSelfAgent(
  req: Request,
  handler: (req: Request) => Promise<Response>,
  refuse: (detail: string) => Response,
): Promise<Response> {
  let raw = '';
  try { raw = await req.clone().text(); } catch { raw = ''; }
  const status = await verifySelfAgentRequest(req, raw);
  if (status.present && status.status === 'invalid') return refuse(status.detail);
  rememberSelfAgent(req, status);
  const res = await handler(req);
  if (!status.present) return res;

  const headers = new Headers(res.headers);
  headers.set('X-AbaPay-Self-Agent', selfAgentHeader(status)!);
  const summary = selfAgentSummary(status);
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try {
      const json = await res.clone().json();
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        if (json.jsonrpc === '2.0' && json.result && typeof json.result === 'object') {
          json.result._meta = { ...(json.result._meta || {}), 'abapay/self_agent': summary };
        } else if (json.jsonrpc !== '2.0') {
          json.self_agent = summary;
        }
        headers.delete('content-length');
        return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
      }
    } catch { /* not JSON after all — header only */ }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
