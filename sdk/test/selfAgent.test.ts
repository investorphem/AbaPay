import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, recoverMessageAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { payBillViaX402, selfAgentHeaders, selfSigningDigest, AbaPayAgent } from "../src/index.js";

// Self Agent ID signing must produce what AbaPay's server checks (src/lib/selfAgent.ts; the main
// repo's tests/selfAgent.test.ts runs these exact headers through the real verifier).

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const URL_ = "https://agents.abapays.com/api/pay/x402?x=1";

describe("selfSigningDigest", () => {
  it("is keccak256(timestamp + METHOD + path?query + keccak256(body))", () => {
    const expected = keccak256(toBytes("1700000000000" + "POST" + "/api/pay/x402?x=1" + keccak256(toBytes("{}"))));
    expect(selfSigningDigest("1700000000000", "post", URL_, "{}")).toBe(expected);
  });
});

describe("selfAgentHeaders", () => {
  it("signs the digest with the agent key", async () => {
    const h = await selfAgentHeaders(agent, { method: "POST", url: URL_, body: "{}" });
    expect(h["x-self-agent-address"]).toBe(agent.address);
    const signer = await recoverMessageAddress({
      message: { raw: selfSigningDigest(h["x-self-agent-timestamp"], "POST", URL_, "{}") },
      signature: h["x-self-agent-signature"] as `0x${string}`,
    });
    expect(signer).toBe(agent.address);
  });

  it("never repeats a timestamp, so two requests never share a signature", async () => {
    const a = await selfAgentHeaders(agent, { method: "POST", url: URL_, body: "{}" }, 5);
    const b = await selfAgentHeaders(agent, { method: "POST", url: URL_, body: "{}" }, 5);
    expect(Number(b["x-self-agent-timestamp"])).toBeGreaterThan(Number(a["x-self-agent-timestamp"]));
    expect(b["x-self-agent-signature"]).not.toBe(a["x-self-agent-signature"]);
  });
});

describe("selfAgent on payments", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("payBillViaX402 signs both the challenge and the paid request", async () => {
    const challenge = {
      x402Version: 2,
      error: "Payment required",
      accepts: [{ scheme: "exact", network: "eip155:42220", amount: "1000", maxAmountRequired: "1000", payTo: "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", maxTimeoutSeconds: 3600, extra: { name: "USDC", version: "2", primaryType: "TransferWithAuthorization" } }],
    };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(challenge), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, status: "SUCCESS", self_agent: { status: "verified", agent_id: "42" } }), { status: 200 }));
    const result = await payBillViaX402({
      signer: agent,
      selfAgent: agent,
      bill: { serviceID: "mtn", serviceCategory: "AIRTIME", network: "MTN", billersCode: "08012345678", nairaAmount: 100, token: "USDC" },
    });
    expect(result.self_agent?.status).toBe("verified");
    const [first, second] = fetchMock.mock.calls.map((c) => c[1].headers as Record<string, string>);
    expect(first["x-self-agent-signature"]).toMatch(/^0x/);
    expect(second["x-self-agent-signature"]).toMatch(/^0x/);
    expect(second["x-self-agent-signature"]).not.toBe(first["x-self-agent-signature"]);
  });

  it("payBillViaX402 sends no Self headers when no selfAgent is given", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    await expect(payBillViaX402({ signer: agent, bill: { serviceID: "mtn", serviceCategory: "AIRTIME", network: "MTN", billersCode: "1", nairaAmount: 100, token: "USDC" } })).rejects.toThrow();
    expect(Object.keys(fetchMock.mock.calls[0][1].headers)).not.toContain("x-self-agent-signature");
  });

  it("confirm sees the offer before signing, and false stops the payment", async () => {
    const challenge = { x402Version: 2, error: "Payment required", accepts: [{ scheme: "exact", network: "eip155:42220", amount: "76758", maxAmountRequired: "76758", payTo: "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", maxTimeoutSeconds: 3600, extra: { name: "USDC", version: "2", primaryType: "TransferWithAuthorization" } }] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(challenge), { status: 402 }));
    const signTypedData = vi.fn();
    const confirm = vi.fn(() => false);
    await expect(payBillViaX402({ signer: { address: agent.address, signTypedData }, confirm, bill: { serviceID: "mtn", serviceCategory: "AIRTIME", network: "MTN", billersCode: "1", nairaAmount: 100, token: "USDC" } })).rejects.toThrow(/declined/);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ amount: "76758", token: "USDC", network: "eip155:42220" }));
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pays with the token asked for, on Celo, whatever order the challenge lists its options in", async () => {
    const opt = (network: string, asset: string, name: string) => ({ scheme: "exact", network, amount: "76758", maxAmountRequired: "76758", payTo: "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C", asset, maxTimeoutSeconds: 3600, extra: { name, version: "1", primaryType: "TransferWithAuthorization" } });
    const challenge = { x402Version: 2, error: "Payment required", accepts: [
      opt("eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USD Coin"),
      opt("eip155:42220", "0xceba9300f2b948710d2653dd7b07f33a8b32118c", "USDC"),
      opt("eip155:42220", "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", "Tether USD"),
    ] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(challenge), { status: 402 }));
    const confirm = vi.fn(() => false);
    await expect(payBillViaX402({ signer: agent, confirm, bill: { serviceID: "mtn", serviceCategory: "AIRTIME", network: "MTN", billersCode: "1", nairaAmount: 100, token: "USDT" } })).rejects.toThrow(/declined/);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ token: "Tether USD", network: "eip155:42220" }));
  });

  it("AbaPayAgent.withSelfAgent signs MCP calls over the exact body sent", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } })));
    await AbaPayAgent.fromApiKey("key", agent.address).withSelfAgent(agent).checkBalance();
    const [url, init] = fetchMock.mock.calls[0];
    const h = init.headers as Record<string, string>;
    const signer = await recoverMessageAddress({
      message: { raw: selfSigningDigest(h["x-self-agent-timestamp"], "POST", url, init.body) },
      signature: h["x-self-agent-signature"] as `0x${string}`,
    });
    expect(signer).toBe(agent.address);
  });
});
