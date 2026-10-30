# TypeScript SDK

{% hint style="info" %}
**`abapay-sdk`** — two functions, matching the two protocol-driven paths in this handbook.
{% endhint %}

Signs with whatever [viem](https://viem.sh) account your agent already has — nothing hidden,
the source is the same wire format documented in [x402](x402.md) and [A2A](a2a.md).

{% hint style="success" %}
**Live on npm** — `npm install abapay-sdk viem`
{% endhint %}

## Zero setup: payBillViaX402

Fetches the 402 challenge, signs it, retries, returns the settlement.

{% code title="pay-via-x402.ts" %}
```ts
import { privateKeyToAccount } from "viem/accounts";
import { payBillViaX402 } from "abapay-sdk";

const key = process.env.PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PRIVATE_KEY must be 0x + 64 hex characters");
const account = privateKeyToAccount(key);

const result = await payBillViaX402({
  signer: account,
  bill: {
    serviceID: "mtn", serviceCategory: "AIRTIME",
    network: "MTN", billersCode: "08012345678",
    nairaAmount: 1000, token: "USDC", // or "USDT" (USD₮), "USAT" (USA₮)
  },
});

console.log(result.status, result.tx_hash);
```
{% endcode %}

## Self Agent ID

If your agent is registered at [app.ai.self.xyz](https://app.ai.self.xyz), pass its key and
every request is signed with it. AbaPay checks the SelfAgentRegistry on Celo and records the
payment as coming from a human-backed agent. See [Self Agent ID](self-agent-id.md).

{% code title="pay-as-self-agent.ts" %}
```ts
const selfAgent = privateKeyToAccount(process.env.SELF_AGENT_KEY);

const result = await payBillViaX402({ signer: account, selfAgent, bill });
console.log(result.self_agent); // { status: "verified", agent_id: "…" }

// MCP: the same, on every tool call
const signed = agent.withSelfAgent(selfAgent);
```
{% endcode %}

## Linked wallet: AbaPayAgent

Links once, sets the PIN in that same call, then reuses the api_key for the full tool
catalog.

{% code title="linked-agent.ts" %}
```ts
import { privateKeyToAccount } from "viem/accounts";
import { AbaPayAgent } from "abapay-sdk";

const key = process.env.PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PRIVATE_KEY must be 0x + 64 hex characters");
const account = privateKeyToAccount(key);

// One-time -- no browser, PIN chosen right here.
const agent = await AbaPayAgent.link({ signer: account, pin: "123456" });

console.log(await agent.checkBalance());
await agent.payBill({
  pin: "123456", service: "AIRTIME", provider: "mtn",
  account_number: "08012345678", amount_ngn: 1000,
  idempotency_key: crypto.randomUUID(), // a retry with the same key never pays twice
});

// Lost the result? Look the payment up instead of paying again.
console.log(await agent.getPaymentStatus("0x…tx hash or request id"));
```
{% endcode %}

## Correctness, not just types

A test in the package asserts the signed typed-data's domain and message match a real 402
challenge byte-for-byte — the exact contract AbaPay's own server-side verification
reconstructs to check the signature against. A silent drift there would be a signature that
fails to verify; the test exists so that drift fails loudly instead.

[Source, tests, and the full README →](https://github.com/investorphem/AbaPay/tree/main/sdk)

Writing Python instead? See the [Python SDK](python-sdk.md) — same two functions, live on PyPI.
