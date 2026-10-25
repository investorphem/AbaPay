import { keccak256, toBytes, type Hex } from "viem";

// 🪪 SELF AGENT ID — optional proof that a request comes from an agent backed by a verified human
// (https://app.ai.self.xyz, the SelfAgentRegistry on Celo). Must match src/lib/selfAgent.ts's
// selfSigningDigest in the main AbaPay repo byte-for-byte, since that is what checks it:
//   digest = keccak256(timestamp + METHOD + path?query + keccak256(rawBody)), signed as a
//   personal message (EIP-191) over the raw 32 bytes.
// Each request is signed afresh: AbaPay refuses a signature it has already seen, and one older
// than five minutes.

/** The agent's own key — the one registered on the SelfAgentRegistry, not necessarily the paying wallet. */
export interface SelfAgentKey {
  address: string;
  signMessage: (args: { message: { raw: Hex } }) => Promise<Hex>;
}

/** What AbaPay made of the Self Agent ID on a response (`self_agent` on JSON, `X-AbaPay-Self-Agent` header). */
export interface SelfAgentResult {
  status: "verified" | "expired" | "not_registered" | "no_human_proof" | "wrong_provider" | "unavailable" | string;
  agent_address?: string;
  agent_id?: string;
  detail?: string;
}

function pathAndQuery(url: string): string {
  const u = new URL(url);
  return (u.pathname || "/") + u.search;
}

export function selfSigningDigest(timestamp: string, method: string, url: string, rawBody: string): Hex {
  return keccak256(toBytes(timestamp + method.toUpperCase() + pathAndQuery(url) + keccak256(toBytes(rawBody))));
}

// Two requests signed in the same millisecond would carry the same signature, and AbaPay refuses
// a repeat — so timestamps only ever go up.
let lastTimestamp = 0;

/** The `x-self-agent-*` headers for one request. `body` must be the exact string you send. */
export async function selfAgentHeaders(
  key: SelfAgentKey,
  request: { method: string; url: string; body?: string },
  now = Date.now(),
): Promise<Record<string, string>> {
  lastTimestamp = Math.max(now, lastTimestamp + 1);
  const timestamp = String(lastTimestamp);
  const signature = await key.signMessage({
    message: { raw: selfSigningDigest(timestamp, request.method, request.url, request.body ?? "") },
  });
  return {
    "x-self-agent-address": key.address,
    "x-self-agent-signature": signature,
    "x-self-agent-timestamp": timestamp,
  };
}
