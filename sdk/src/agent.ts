import type { Signer } from "./types.js";
import { AbaPayError } from "./types.js";
import { DEFAULT_BASE_URL } from "./x402.js";

// ⚡ THE OTHER WAY IN — a reusable version of examples/agent-quickstart.mjs (verified live
// against production 2026-09-11: a throwaway key ran this exact request shape, got a real
// api_key back, called check_balance with it, then unlinked itself). Unlike x402.ts, this path
// links a wallet ONCE (a signature, not a deposit) and then calls the fuller MCP tool catalog
// with an api_key + a PIN on every payment — see https://agents.abapays.com/#a2a for why the
// two paths have genuinely different trust models.

export type ApprovedChain = "CELO" | "BASE";

export interface LinkParams {
  signer: Signer & { signMessage: (args: { message: string }) => Promise<`0x${string}`> };
  /** 4-6 digits. Yours to pick; AbaPay never generates or stores it in recoverable form. */
  pin: string;
  approvedChain?: ApprovedChain;
  approvedToken?: string;
  /** Shown in AbaPay's Agent Hub UI so a human can tell which integration minted this key. */
  label?: string;
  baseUrl?: string;
}

interface LinkResponse {
  success: boolean;
  api_key?: string;
  message?: string;
}

interface McpCallResponse {
  result?: { content?: { type: string; text?: string }[] };
  error?: { message?: string };
}

/**
 * A linked AbaPay agent session — one api_key, reusable across as many tool calls as needed.
 * Get one via {@link AbaPayAgent.link}.
 */
export class AbaPayAgent {
  private constructor(
    public readonly apiKey: string,
    public readonly walletAddress: string,
    private readonly baseUrl: string,
  ) {}

  /**
   * Prove ownership of a wallet with a plain signed message (no OAuth, no browser) and mint an
   * Agent Hub api_key. This does NOT grant AbaPay any spending allowance by itself — that's a
   * separate on-chain step (`approve` + `setSpendingAllowance`, see README.md's AbaPayV4
   * section or `examples/agent-quickstart.mjs`), deliberately left to the caller rather than
   * done here, since it moves the caller's own funds and shouldn't happen implicitly inside a
   * "just log in" call.
   *
   * @throws {AbaPayError} if the signature is rejected or the PIN is malformed.
   */
  static async link(params: LinkParams): Promise<AbaPayAgent> {
    const { signer, pin, approvedChain = "CELO", approvedToken, label, baseUrl = DEFAULT_BASE_URL } = params;
    if (!/^\d{4,6}$/.test(pin)) {
      throw new AbaPayError("PIN must be 4-6 digits.");
    }

    const timestamp = String(Date.now());
    const message = `AbaPay Agent Action: POST:/api/agent/link: ${timestamp}`;
    const signature = await signer.signMessage({ message });

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/agent/link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-address": signer.address,
        "x-wallet-signature": signature,
        "x-wallet-timestamp": timestamp,
      },
      body: JSON.stringify({
        wallet_address: signer.address,
        channel: "MCP",
        pin,
        approved_chain: approvedChain,
        approved_token: approvedToken,
        mcp_key_label: label || "abapay-sdk",
      }),
    });
    const data = (await res.json()) as LinkResponse;
    if (!data.success || !data.api_key) {
      throw new AbaPayError(data.message || `Link failed (HTTP ${res.status}).`, undefined, data);
    }
    return new AbaPayAgent(data.api_key, signer.address, baseUrl);
  }

  /** Reattach to an api_key minted earlier (e.g. one saved from a previous {@link link} call) — no new signature needed. */
  static fromApiKey(apiKey: string, walletAddress: string, baseUrl = DEFAULT_BASE_URL): AbaPayAgent {
    return new AbaPayAgent(apiKey, walletAddress, baseUrl);
  }

  /** Low-level: call any MCP tool by name. `checkBalance`/`payBill`/etc. below cover the common ones with typed args. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { api_key: this.apiKey, ...args } },
      }),
    });
    const data = (await res.json()) as McpCallResponse;
    if (data.error) throw new AbaPayError(data.error.message || "MCP tool call failed.", undefined, data);
    const text = data.result?.content?.find((c) => c.type === "text")?.text;
    if (text === undefined) throw new AbaPayError("MCP tool returned no text content.", undefined, data);
    return text;
  }

  checkBalance(chain: ApprovedChain = "CELO"): Promise<string> {
    return this.callTool("check_balance", { chain });
  }

  payBill(args: {
    pin: string;
    service: string;
    provider: string;
    account_number: string;
    amount_ngn: number;
    chain?: ApprovedChain;
    token?: string;
    variation_code?: string;
  }): Promise<string> {
    return this.callTool("pay_bill", args);
  }

  scheduleBill(args: Record<string, unknown>): Promise<string> {
    return this.callTool("schedule_bill", args);
  }

  transactionHistory(args: Record<string, unknown> = {}): Promise<string> {
    return this.callTool("transaction_history", args);
  }
}
