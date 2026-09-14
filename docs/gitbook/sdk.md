# TypeScript SDK

> `abapay-sdk`

Two functions, matching the two protocol-driven paths in this handbook. Signs with whatever
[viem](https://viem.sh) account your agent already has — nothing hidden, the source is the
same wire format documented in [x402](x402.md) and [A2A](a2a.md).

**Live on npm** — `npm install abapay-sdk viem`

## Zero setup: payBillViaX402

Fetches the 402 challenge, signs it, retries, returns the settlement.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { payBillViaX402 } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const result = await payBillViaX402({
  signer: account,
  bill: {
    serviceID: "mtn", serviceCategory: "AIRTIME",
    network: "MTN", billersCode: "08012345678",
    nairaAmount: 1000, token: "USDT",
  },
});

console.log(result.status, result.tx_hash);
```

## Linked wallet: AbaPayAgent

Links once, sets the PIN in that same call, then reuses the api_key for the full tool
catalog.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { AbaPayAgent } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

// One-time -- no browser, PIN chosen right here.
const agent = await AbaPayAgent.link({ signer: account, pin: "1234" });

console.log(await agent.checkBalance());
await agent.payBill({
  pin: "1234", service: "AIRTIME", provider: "mtn",
  account_number: "08012345678", amount_ngn: 1000,
});
```

## Correctness, not just types

A test in the package asserts the signed typed-data's domain and message match a real 402
challenge byte-for-byte — the exact contract AbaPay's own server-side verification
reconstructs to check the signature against. A silent drift there would be a signature that
fails to verify; the test exists so that drift fails loudly instead.

[Source, tests, and the full README →](https://github.com/investorphem/AbaPay/tree/main/sdk)
