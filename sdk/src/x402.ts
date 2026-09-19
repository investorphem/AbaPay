import type { Hex } from "viem";
import type { BillDetails, Signer, X402PayResult } from "./types.js";
import { AbaPayError } from "./types.js";

export const DEFAULT_BASE_URL = "https://agents.abapays.com";

// ⚡ THE EIP-712 TYPES — must match src/lib/x402Settle.ts's TRANSFER_WITH_AUTHORIZATION_TYPES
// in the main AbaPay repo byte-for-byte, since that file is what verifies the signature this
// produces. Duplicated here (rather than imported) because this package is published
// standalone and cannot depend on the Next.js app's internal src/lib — if AbaPay ever changes
// this type, the change has to land in both places, and this comment is the tripwire for that.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface X402Accept {
  scheme: string;
  network: string; // CAIP-2, e.g. "eip155:42220"
  amount: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; primaryType: string };
}

interface X402Challenge {
  x402Version: number;
  error: string;
  accepts: X402Accept[];
}

// Runtime-agnostic base64 — this SDK has no hard Node dependency (agents run in browsers,
// edge functions, and Deno/Bun too), so `Buffer` isn't assumed available.
function toBase64(json: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(json, "utf-8").toString("base64");
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  // Prefer Web Crypto (Node 18+, browsers, edge runtimes) — no extra dependency, works
  // everywhere this package's peer (viem) already assumes a modern runtime.
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function caip2ChainId(network: string): number {
  const parts = network.split(":");
  const id = Number(parts[1]);
  if (parts[0] !== "eip155" || !Number.isFinite(id)) {
    throw new AbaPayError(
      `Unsupported x402 network "${network}" — this SDK version only understands eip155:* (EVM) networks, and only Celo (eip155:42220) is currently offered by AbaPay.`,
    );
  }
  return id;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AbaPayError(`AbaPay returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Pay a real-world bill (airtime, data, electricity, cable) via x402 — zero setup.
 *
 * The agent's own wallet signs an EIP-3009 `transferWithAuthorization` for exactly the amount
 * AbaPay's server names in its 402 challenge; nothing here ever touches abapays.com, an Agent
 * Hub account, or a PIN. This is the same flow documented at https://agents.abapays.com/#x402 —
 * see there for the full request/response shapes this function builds.
 *
 * Celo mainnet only in this version. `bill.token` must be a token the challenge actually offers
 * (USDC or USDT on Celo, both EIP-3009-capable) — offering an unsupported token surfaces as the
 * `AbaPayError` thrown when the challenge has no matching `accepts[]` entry, not a silent
 * fallback to a token you didn't ask for.
 *
 * @throws {AbaPayError} on any HTTP failure, a challenge this SDK version can't act on, or a
 *   final response AbaPay itself reports as unsuccessful (`success: false`).
 */
export async function payBillViaX402(params: {
  signer: Signer;
  bill: Omit<BillDetails, "wallet_address"> & { wallet_address?: string };
  baseUrl?: string;
}): Promise<X402PayResult> {
  const { signer, baseUrl = DEFAULT_BASE_URL } = params;
  const bill: BillDetails = { ...params.bill, wallet_address: params.bill.wallet_address ?? signer.address };
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/pay/x402`;

  // ── 1. Ask for a price. No X-PAYMENT header yet — this MUST come back 402. ──────────────
  const challengeRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bill),
  });

  if (challengeRes.status !== 402) {
    // A well-behaved x402 resource never settles a payment it hasn't been paid for — a
    // non-402 here (200, 4xx, 5xx) means something is wrong with the request itself, not a
    // reason to sign anything.
    const body = await readJson(challengeRes).catch(() => null);
    throw new AbaPayError(
      `Expected HTTP 402 (payment required), got ${challengeRes.status}.`,
      undefined,
      body,
    );
  }

  const challenge: X402Challenge = await readJson(challengeRes);
  const accept = challenge.accepts?.find((a) => a.scheme === "exact");
  if (!accept) {
    throw new AbaPayError("402 challenge carried no usable 'exact' payment option.", undefined, challenge);
  }

  // ── 2. Sign the exact amount the challenge named, with the wallet's OWN key. ─────────────
  const chainId = caip2ChainId(accept.network);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: signer.address,
    to: accept.payTo,
    value: accept.amount,
    // 60s of slack behind "now" absorbs ordinary clock skew between this machine and
    // whichever node eventually checks validAfter on-chain.
    validAfter: String(now - 60),
    validBefore: String(now + (accept.maxTimeoutSeconds || 3600)),
    nonce: randomNonce(),
  };

  const signature = await signer.signTypedData({
    domain: {
      name: accept.extra.name,
      version: accept.extra.version,
      chainId,
      verifyingContract: accept.asset as Hex,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as Hex,
      to: authorization.to as Hex,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  // ── 3. Retry with the signed authorization attached. ─────────────────────────────────────
  // x402Version/scheme/network in this envelope are metadata AbaPay's server does not trust
  // from the client and overrides with the one combo proven to settle on its facilitator — see
  // src/app/api/pay/x402/route.ts's own comment on this exact point. Sending them is required
  // by the wire format; their value here doesn't affect what actually settles.
  const paymentHeader = toBase64(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "celo",
      payload: { signature, authorization },
    }),
  );

  const settleRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader },
    body: JSON.stringify(bill),
  });
  const result: X402PayResult = await readJson(settleRes);

  if (!settleRes.ok || result.success === false) {
    throw new AbaPayError(result.message || `Settlement failed (HTTP ${settleRes.status}).`, undefined, result);
  }
  return result;
}
