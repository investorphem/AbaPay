import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseSiweMessage } from "viem/siwe";
import { AbaPayAgent, AbaPayError } from "../src/index.js";

const nonceResponse = () => new Response(JSON.stringify({ success: true, nonce: "n0nce12345abc" }), { status: 200 });

function fakeSigner(address = "0xa9e00000000000000000000000000000000000a1") {
  return {
    address,
    signMessage: vi.fn(async ({ message }: { message: string }) => `0xsigned:${message}`),
    signTypedData: vi.fn(),
  };
}

describe("AbaPayAgent.link", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("signs a SIWE (EIP-4361) message for /api/agent/link with the server's nonce, sent as headers", async () => {
    fetchMock
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, api_key: "aba_mcp_test123" }), { status: 200 }));

    const signer = fakeSigner();
    const agent = await AbaPayAgent.link({ signer, pin: "123456" });

    expect(agent.apiKey).toBe("aba_mcp_test123");
    expect(agent.walletAddress).toBe(signer.address);

    expect(fetchMock.mock.calls[0][0]).toBe("https://agents.abapays.com/api/auth/nonce?purpose=action");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://agents.abapays.com/api/agent/link");
    expect(init.headers["x-wallet-address"]).toBe(signer.address);

    // The signed message is exactly the one carried in x-wallet-siwe, and is a valid SIWE
    // message bound to this domain, nonce and action.
    const message = Buffer.from(init.headers["x-wallet-siwe"], "base64").toString("utf8");
    expect(init.headers["x-wallet-signature"]).toBe(`0xsigned:${message}`);
    const siwe = parseSiweMessage(message);
    expect(siwe.domain).toBe("agents.abapays.com");
    expect(siwe.nonce).toBe("n0nce12345abc");
    expect(siwe.address?.toLowerCase()).toBe(signer.address);
    expect(siwe.resources).toEqual(["abapay:action:POST:/api/agent/link"]);
    expect(siwe.expirationTime!.getTime() - siwe.issuedAt!.getTime()).toBe(5 * 60 * 1000);

    const body = JSON.parse(init.body);
    expect(body.pin).toBe("123456");
    expect(body.channel).toBe("MCP");
    expect(body.approved_chain).toBe("CELO");
  });

  it("rejects a malformed PIN before making any network call", async () => {
    await expect(AbaPayAgent.link({ signer: fakeSigner(), pin: "12" })).rejects.toThrow(AbaPayError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws AbaPayError when the server refuses to link", async () => {
    fetchMock
      .mockResolvedValueOnce(nonceResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, message: "Signature does not match wallet." }), { status: 401 }));
    await expect(AbaPayAgent.link({ signer: fakeSigner(), pin: "123456" })).rejects.toThrow(
      "Signature does not match wallet.",
    );
  });
});

describe("AbaPayAgent tool calls", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("checkBalance sends the api_key and parses the text content back out", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { content: [{ type: "text", text: "**Wallet:** 12.34 USDT" }] } }), {
        status: 200,
      }),
    );
    const agent = AbaPayAgent.fromApiKey("aba_mcp_test123", "0xWallet");
    const text = await agent.checkBalance();
    expect(text).toBe("**Wallet:** 12.34 USDT");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.name).toBe("check_balance");
    expect(body.params.arguments.api_key).toBe("aba_mcp_test123");
  });

  it("surfaces an MCP error as AbaPayError instead of returning undefined text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid PIN" } }), { status: 200 }),
    );
    const agent = AbaPayAgent.fromApiKey("aba_mcp_test123", "0xWallet");
    await expect(agent.payBill({
      pin: "0000", service: "AIRTIME", provider: "mtn", account_number: "080", amount_ngn: 100,
    })).rejects.toThrow("Invalid PIN");
  });

  it("payBill forwards idempotency_key, and getPaymentStatus sends the reference", async () => {
    const ok = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
    fetchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    const agent = AbaPayAgent.fromApiKey("aba_mcp_test123", "0xWallet");

    await agent.payBill({
      pin: "123456", service: "AIRTIME", provider: "mtn", account_number: "080", amount_ngn: 100,
      idempotency_key: "order-0001",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).params.arguments.idempotency_key).toBe("order-0001");

    await agent.getPaymentStatus("0xabc");
    const status = JSON.parse(fetchMock.mock.calls[1][1].body).params;
    expect(status.name).toBe("get_payment_status");
    expect(status.arguments.reference).toBe("0xabc");
  });
});
