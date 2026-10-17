import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { after } from 'next/server';
import { pad, parseAbi, parseAbiItem } from 'viem';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { getPublicClient, isMainnetEnv } from '@/lib/chain';
import { errorMessage } from '@/lib/errors';
import { oauthClientForAccessToken } from '@/lib/deai/mcpOAuth';
import type { Erc8004Agent, PayerIdentity } from '@/lib/payerIdentityTypes';

export type { Erc8004Agent, PayerIdentity };

// 🤖 WHO IS PAYING — agent identity for the ADMIN DASHBOARD ONLY.
//
// x402 and agent payments arrive from a wallet, and a wallet alone says nothing about which agent
// sent it. The chain does, publicly:
//   - ERC-8004 IdentityRegistry: agents register as an NFT whose metadata names them, describes
//     them and lists their endpoints and wallet. We list the identities this wallet OWNS, plus the
//     one the request declares if the registry names this wallet as that agent's wallet.
//   - Self Agent ID (SelfAgentRegistry, @selfxyz/agent-sdk): an agent key bound to a real human by
//     a ZK passport proof. For an EVM agent the key is its address, zero-padded to 32 bytes.
//
// Never decides anything about a payment: it runs after the response, every failure is recorded
// and swallowed, and the results are only read by /api/admin/data (migration 044 keeps both
// tables service-role only). Reads go through getPublicClient, so production uses CELO_RPC_URL
// (Chainstack) first.

const NETWORKS = {
  mainnet: {
    erc8004: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    // Block the ERC-8004 registry proxy was deployed in — the log scan starts here.
    erc8004FromBlock: BigInt(58_396_724),
    self: '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944',
    blockscout: 'https://celo.blockscout.com',
  },
  testnet: {
    erc8004: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    erc8004FromBlock: BigInt(0),
    self: '0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379',
    blockscout: 'https://celo-sepolia.blockscout.com',
  },
} as const;

const ERC8004_ABI = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
]);
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
const SELF_ABI = parseAbi([
  'function isVerifiedAgent(bytes32 agentPubKey) view returns (bool)',
  'function getAgentId(bytes32 agentPubKey) view returns (uint256)',
  'function hasHumanProof(uint256 agentId) view returns (bool)',
  'function isProofFresh(uint256 agentId) view returns (bool)',
]);

const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_AGENTS = 5;

const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
const httpUrl = (v: unknown) => {
  const s = clip(v, 300);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
};

/** The fields we keep from an ERC-8004 registration document. Untrusted input: clipped, URLs http(s) only. */
export function agentFieldsFromMetadata(meta: unknown): Omit<Erc8004Agent, 'id' | 'relation'> {
  if (!meta || typeof meta !== 'object') return {};
  const m = meta as Record<string, unknown>;
  const services = [...(Array.isArray(m.services) ? m.services : []), ...(Array.isArray(m.endpoints) ? m.endpoints : [])] as Record<string, unknown>[];
  const find = (kind: string) => {
    const s = services.find((e) => e && typeof e === 'object' && String(e.type ?? e.name ?? '').toLowerCase() === kind);
    return s ? httpUrl(s.endpoint ?? s.url) : undefined;
  };
  return {
    name: clip(m.name, 80),
    description: clip(m.description, 300),
    web: find('web'),
    x402: find('x402'),
    image: httpUrl(m.image),
    active: typeof m.active === 'boolean' ? m.active : undefined,
  };
}

/** A `data:application/json` tokenURI decoded locally. Remote URIs are never fetched (agent-controlled URLs). */
function metadataFromDataUri(uri: string): unknown {
  const m = uri.match(/^data:application\/json(;base64)?,([\s\S]*)$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]));
  } catch {
    return null;
  }
}

type Net = (typeof NETWORKS)[keyof typeof NETWORKS];

/** Agent ids the wallet holds, with the metadata Blockscout already resolved. Null when Blockscout can't answer. */
async function idsFromBlockscout(net: Net, wallet: string): Promise<Map<string, unknown> | null> {
  try {
    const res = await fetch(`${net.blockscout}/api/v2/addresses/${wallet}/nft?type=ERC-721`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const body = await res.json() as { items?: { id?: string; metadata?: unknown; token?: { address_hash?: string; address?: string } }[] };
    const out = new Map<string, unknown>();
    for (const item of body.items ?? []) {
      const token = String(item.token?.address_hash ?? item.token?.address ?? '').toLowerCase();
      if (token === net.erc8004.toLowerCase() && item.id && /^\d+$/.test(item.id)) out.set(item.id, item.metadata ?? null);
    }
    return out;
  } catch {
    return null;
  }
}

/** Fallback: the registry's own mint/transfer log, read from our RPC (Chainstack in production). */
async function idsFromLogs(net: Net, wallet: string): Promise<Map<string, unknown>> {
  const client = getPublicClient('CELO');
  const logs = await client.getLogs({ address: net.erc8004, event: TRANSFER_EVENT, args: { to: wallet as `0x${string}` }, fromBlock: net.erc8004FromBlock, toBlock: 'latest' });
  return new Map(logs.map((l) => [String(l.args.tokenId), null]));
}

/** Everything the chain says about a wallet. Pure lookup, no writes. */
export async function lookupPayerIdentity(wallet: string, opts: { declaredAgentId?: string | null } = {}): Promise<PayerIdentity> {
  const w = wallet.toLowerCase();
  const net = isMainnetEnv() ? NETWORKS.mainnet : NETWORKS.testnet;
  const client = getPublicClient('CELO');
  const errors: string[] = [];

  // Self Agent ID.
  let selfVerified: boolean | null = null;
  let selfAgentId: string | null = null;
  let humanProof: boolean | null = null;
  let proofFresh: boolean | null = null;
  try {
    const key = pad(w as `0x${string}`, { size: 32 });
    selfVerified = await client.readContract({ address: net.self, abi: SELF_ABI, functionName: 'isVerifiedAgent', args: [key] });
    const id = await client.readContract({ address: net.self, abi: SELF_ABI, functionName: 'getAgentId', args: [key] });
    if (id > BigInt(0)) {
      selfAgentId = id.toString();
      [humanProof, proofFresh] = await Promise.all([
        client.readContract({ address: net.self, abi: SELF_ABI, functionName: 'hasHumanProof', args: [id] }).catch(() => null),
        client.readContract({ address: net.self, abi: SELF_ABI, functionName: 'isProofFresh', args: [id] }).catch(() => null),
      ]);
    }
  } catch (e) {
    errors.push(`self: ${errorMessage(e).slice(0, 120)}`);
  }

  // ERC-8004: candidates from Blockscout (or the log), each confirmed against the registry itself.
  let candidates = await idsFromBlockscout(net, w);
  if (!candidates) {
    candidates = await idsFromLogs(net, w).catch((e) => {
      errors.push(`erc8004 ids: ${errorMessage(e).slice(0, 120)}`);
      return new Map<string, unknown>();
    });
  }
  const declared = opts.declaredAgentId && /^\d{1,20}$/.test(opts.declaredAgentId) ? opts.declaredAgentId : null;
  if (declared && !candidates.has(declared)) candidates.set(declared, null);

  const agents: Erc8004Agent[] = [];
  for (const [id, meta] of [...candidates].slice(0, MAX_AGENTS + 1)) {
    try {
      const agentId = BigInt(id);
      const owner = String(await client.readContract({ address: net.erc8004, abi: ERC8004_ABI, functionName: 'ownerOf', args: [agentId] })).toLowerCase();
      let relation: Erc8004Agent['relation'] | null = owner === w ? 'owner' : null;
      if (!relation) {
        const agentWallet = await client.readContract({ address: net.erc8004, abi: ERC8004_ABI, functionName: 'getAgentWallet', args: [agentId] }).catch(() => null);
        if (agentWallet && String(agentWallet).toLowerCase() === w) relation = 'agent_wallet';
      }
      if (!relation) continue; // the indexer was stale, or the declared id isn't this wallet's

      let metadata = meta;
      if (!metadata) {
        const uri = await client.readContract({ address: net.erc8004, abi: ERC8004_ABI, functionName: 'tokenURI', args: [agentId] }).catch(() => '');
        metadata = metadataFromDataUri(String(uri));
      }
      agents.push({ id, relation, ...agentFieldsFromMetadata(metadata) });
      if (agents.length >= MAX_AGENTS) break;
    } catch (e) {
      errors.push(`erc8004 #${id}: ${errorMessage(e).slice(0, 80)}`);
    }
  }

  return {
    wallet: w,
    erc8004_agents: agents,
    self_verified: selfVerified,
    self_agent_id: selfAgentId,
    self_human_proof: humanProof,
    self_proof_fresh: proofFresh,
    checked_at: new Date().toISOString(),
    lookup_error: errors.length ? errors.join(' · ').slice(0, 500) : null,
  };
}

/** Look the wallet up unless a fresh answer is cached (and already covers the declared agent id). */
export async function refreshPayerIdentity(wallet: string, opts: { declaredAgentId?: string | null; now?: number } = {}) {
  if (!isAddress(wallet)) return null;
  const w = wallet.toLowerCase();
  const { data: cached } = await supabase.from('payer_identities').select('*').eq('wallet', w).maybeSingle();
  const row = cached as PayerIdentity | null;
  const fresh = row && (opts.now ?? Date.now()) - new Date(row.checked_at).getTime() < CACHE_MS && !row.lookup_error;
  const coversDeclared = !opts.declaredAgentId || (row?.erc8004_agents ?? []).some((a) => a.id === opts.declaredAgentId);
  if (fresh && coversDeclared) return row;

  const identity = await lookupPayerIdentity(w, opts);
  const { error } = await supabase.from('payer_identities').upsert(identity, { onConflict: 'wallet' });
  if (error) console.warn('[PayerIdentity] cache write failed:', error.message);
  return identity;
}

/** What the request said about its client. Claims, shown beside the on-chain facts. */
export function clientInfoFromRequest(req: Request, clientDiag?: unknown) {
  const h = (name: string, n: number) => clip(req.headers.get(name), n) ?? null;
  const declaredId = h('x-agent-id', 40);
  return {
    user_agent: h('user-agent', 300),
    declared_agent: h('x-agent-name', 80),
    declared_agent_id: declaredId && /^\d{1,20}$/.test(declaredId) ? declaredId : null,
    client_diag: clientDiag && typeof clientDiag === 'object' ? clientDiag : null,
  };
}

export type PaymentClient = ReturnType<typeof clientInfoFromRequest>;
type ClientSource = PaymentClient | (() => Promise<PaymentClient>);

/**
 * Record the payment's client info and refresh the payer's identity — after the response is sent.
 * `client` may be a function, resolved only then (MCP/A2A: the OAuth client lookup costs a
 * query that only a payment should pay for). Outside a request (tests, scripts) `after` throws;
 * the work then just runs detached.
 */
export function recordPayerAfterResponse(transactionId: string, wallet: string, client: ClientSource) {
  const work = async () => {
    try {
      const info = typeof client === 'function' ? await client() : client;
      const { error } = await supabase.from('payment_client_info').insert({ transaction_id: transactionId, wallet: wallet.toLowerCase(), ...info });
      if (error) console.warn('[PayerIdentity] client info write failed:', error.message);
      await refreshPayerIdentity(wallet, { declaredAgentId: info.declared_agent_id });
    } catch (e) {
      console.warn('[PayerIdentity] lookup failed:', errorMessage(e));
    }
  };
  try {
    after(work);
  } catch {
    void work();
  }
}

// ⚡ MCP and A2A pay through executeAgentPayment (src/lib/deai/batch.ts), which our own chat
// agent and the scheduler also use — and a tool can be authenticated by a header or by an
// api_key argument deep inside it. So rather than thread the client through every tool, the two
// routes run each call inside this context and executeAgentPayment records whatever is set.
// Chat and the scheduler never set it, so nothing is recorded for them.
const agentClient = new AsyncLocalStorage<() => Promise<PaymentClient>>();

export function runWithAgentClient<T>(client: () => Promise<PaymentClient>, fn: () => Promise<T>): Promise<T> {
  return agentClient.run(client, fn);
}

/** Called by executeAgentPayment once its row exists. A no-op outside an MCP/A2A request. */
export function recordAgentPaymentClient(transactionId: string, wallet: string) {
  const client = agentClient.getStore();
  if (client) recordPayerAfterResponse(transactionId, wallet, client);
}

/**
 * The client of an MCP/A2A request: its headers now, and — only when a payment needs it — the
 * OAuth client the bearer token was issued to (its self-registered name, e.g. "Claude").
 */
export function agentRequestClient(req: Request, protocol: 'MCP' | 'A2A') {
  const base = clientInfoFromRequest(req);
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const auth = !bearer ? 'api_key_argument' : bearer.startsWith('aba_mcp_') ? 'api_key' : 'oauth';
  return async (): Promise<PaymentClient> => {
    const oauth = auth === 'oauth' ? await oauthClientForAccessToken(bearer).catch(() => null) : null;
    return {
      ...base,
      declared_agent: base.declared_agent ?? clip(oauth?.client_name, 80) ?? null,
      client_diag: { protocol, auth, ...(oauth ? { oauth_client_id: oauth.client_id, oauth_client_name: oauth.client_name } : {}) },
    };
  };
}
