import { describe, it, expect, vi, beforeEach } from "vitest";
import { AbaPayAgent, AbaPayError } from "../src/index.js";

function fakeSigner(address = "0xAgent0000000000000000000000000000000001") {
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

  it("signs the exact message shape /api/agent/link expects and sends it as headers, not the body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, api_key: "aba_mcp_test123" }), { status: 200 }),
    );

    const signer = fakeSigner();
    const agent = await AbaPayAgent.link({ signer, pin: "1234" });

    expect(agent.apiKey).toBe("aba_mcp_test123");
    expect(agent.walletAddress).toBe(signer.address);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.abapays.com/api/agent/link");
    expect(init.headers["x-wallet-address"]).toBe(signer.address);
    expect(init.headers["x-wallet-signature"]).toMatch(/^0xsigned:AbaPay Agent Action: POST:\/api\/agent\/link: \d+$/);

    const body = JSON.parse(init.body);
    expect(body.pin).toBe("1234");
    expect(body.channel).toBe("MCP");
    expect(body.approved_chain).toBe("CELO");
  });

  it("rejects a malformed PIN before making any network call", async () => {
    await expect(AbaPayAgent.link({ signer: fakeSigner(), pin: "12" })).rejects.toThrow(AbaPayError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws AbaPayError when the server refuses to link", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, message: "Signature does not match wallet." }), { status: 401 }),
    );
    await expect(AbaPayAgent.link({ signer: fakeSigner(), pin: "1234" })).rejects.toThrow(
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
});
