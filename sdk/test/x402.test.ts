import { describe, it, expect, vi, beforeEach } from "vitest";
import { payBillViaX402, AbaPayError } from "../src/index.js";

// A fake signer that records exactly what it was asked to sign, so tests can assert the typed
// data matches the real server's TRANSFER_WITH_AUTHORIZATION_TYPES / domain construction
// without needing a real wallet or a real network.
function fakeSigner(address = "0xAgent0000000000000000000000000000000001") {
  const calls: any[] = [];
  return {
    address,
    calls,
    signTypedData: vi.fn(async (args: any) => {
      calls.push(args);
      return "0xsignedSignatureBytes";
    }),
  };
}

const CHALLENGE = {
  x402Version: 1,
  error: "Payment required",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:42220",
      amount: "6849230000000000000",
      maxAmountRequired: "6849230000000000000",
      payTo: "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C",
      asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
      maxTimeoutSeconds: 86400,
      extra: { name: "Tether USD", version: "1", primaryType: "TransferWithAuthorization" },
    },
  ],
};

const bill = {
  serviceID: "mtn",
  serviceCategory: "AIRTIME" as const,
  network: "MTN",
  billersCode: "08012345678",
  nairaAmount: 1000,
  token: "USDT" as const,
};

describe("payBillViaX402", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("signs the exact domain/amount/payTo the 402 challenge named, then retries with X-PAYMENT", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(CHALLENGE), { status: 402 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, status: "SUCCESS", tx_hash: "0xabc", request_id: "req1" }), {
          status: 200,
        }),
      );

    const signer = fakeSigner();
    const result = await payBillViaX402({ signer, bill });

    expect(result.success).toBe(true);
    expect(result.tx_hash).toBe("0xabc");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: no X-PAYMENT header — this must genuinely provoke a fresh 402, not smuggle a
    // stale/guessed signature in on the first attempt.
    const firstCallHeaders = fetchMock.mock.calls[0][1].headers;
    expect(firstCallHeaders["X-PAYMENT"]).toBeUndefined();

    // The signed typed data matches the challenge byte-for-byte: this is the exact contract
    // src/lib/x402Settle.ts's transferAuthorizationTypedData() reconstructs server-side to
    // verify against — any drift here is a signature that will not verify.
    expect(signer.calls).toHaveLength(1);
    const signed = signer.calls[0];
    expect(signed.domain).toEqual({
      name: "Tether USD",
      version: "1",
      chainId: 42220,
      verifyingContract: CHALLENGE.accepts[0].asset,
    });
    expect(signed.primaryType).toBe("TransferWithAuthorization");
    expect(signed.message.from).toBe(signer.address);
    expect(signed.message.to).toBe(CHALLENGE.accepts[0].payTo);
    expect(signed.message.value).toBe(BigInt(CHALLENGE.accepts[0].amount));

    // Second call carries the signed authorization, base64-encoded, in X-PAYMENT.
    const secondCallHeaders = fetchMock.mock.calls[1][1].headers;
    const decoded = JSON.parse(Buffer.from(secondCallHeaders["X-PAYMENT"], "base64").toString("utf-8"));
    expect(decoded.payload.signature).toBe("0xsignedSignatureBytes");
    expect(decoded.payload.authorization.to).toBe(CHALLENGE.accepts[0].payTo);
    expect(decoded.payload.authorization.value).toBe(CHALLENGE.accepts[0].amount);
    expect(decoded.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("throws AbaPayError when the first response isn't a 402", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad request" }), { status: 400 }));
    await expect(payBillViaX402({ signer: fakeSigner(), bill })).rejects.toThrow(AbaPayError);
  });

  it("throws AbaPayError on a non-EVM / unrecognized network in the challenge", async () => {
    const badChallenge = {
      ...CHALLENGE,
      accepts: [{ ...CHALLENGE.accepts[0], network: "solana:mainnet" }],
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(badChallenge), { status: 402 }));
    await expect(payBillViaX402({ signer: fakeSigner(), bill })).rejects.toThrow(/Unsupported x402 network/);
  });

  it("throws AbaPayError when the final settlement reports success: false", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(CHALLENGE), { status: 402 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, status: "FAILED_VENDING", message: "Provider rejected it" }), {
          status: 200,
        }),
      );
    await expect(payBillViaX402({ signer: fakeSigner(), bill })).rejects.toThrow("Provider rejected it");
  });

  it("defaults wallet_address to the signer's own address when not given", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(CHALLENGE), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, status: "SUCCESS" }), { status: 200 }));
    const signer = fakeSigner("0xDeadBeef00000000000000000000000000dEaD");
    await payBillViaX402({ signer, bill });
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstBody.wallet_address).toBe(signer.address);
  });
});
