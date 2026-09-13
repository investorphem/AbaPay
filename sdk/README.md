# abapay-sdk

Pay real-world bills — airtime, mobile data, electricity, cable TV — from an agent's own Celo
wallet. Two ways in, matching [agents.abapays.com](https://agents.abapays.com):

- **`payBillViaX402`** — zero setup. No account, no API key, no PIN, no visit to abapays.com.
  Your agent's wallet signs one EIP-3009 authorization and the bill is paid.
- **`AbaPayAgent`** — a linked-wallet client for the fuller MCP tool catalog (balances, history,
  schedules, batch payments). One on-chain signature to link, then an API key + PIN per payment.

Full protocol details: [docs/AGENT_INTEGRATION.md](https://github.com/investorphem/AbaPay/blob/main/docs/AGENT_INTEGRATION.md).
Celo mainnet only in this version.

## Install

```bash
npm install abapay-sdk viem
```

`viem` is a peer dependency — this package signs through whatever `Account`/`WalletClient` your
own viem install already gives you, rather than bundling a second copy.

## Zero setup: pay a bill via x402

```ts
import { privateKeyToAccount } from "viem/accounts";
import { payBillViaX402 } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const result = await payBillViaX402({
  signer: account,
  bill: {
    serviceID: "mtn",
    serviceCategory: "AIRTIME",
    network: "MTN",
    billersCode: "08012345678",
    nairaAmount: 1000,
    token: "USDT",
  },
});

console.log(result.status, result.tx_hash);
```

That's the whole integration. `account` never touches abapays.com beyond this one HTTP call —
no account creation, no API key, no PIN. This is the flow described at
[agents.abapays.com/#x402](https://agents.abapays.com/#x402): the agent holds a Celo wallet,
calls the endpoint, gets a `402 Payment Required`, signs the exact amount named in the
challenge, and retries. `payBillViaX402` does the challenge/sign/retry for you; nothing about
the wire format is hidden — read `src/x402.ts` if you want to see or reimplement it in another
language.

## Linked wallet: the fuller tool catalog

```ts
import { privateKeyToAccount } from "viem/accounts";
import { AbaPayAgent } from "abapay-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// One-time: prove wallet ownership, mint an Agent Hub api_key. Save agent.apiKey somewhere —
// there is no recovery flow other than linking again.
const agent = await AbaPayAgent.link({ signer: account, pin: "1234" });

// Elsewhere, an on-chain approve() + setSpendingAllowance() grants AbaPay a bounded, revocable
// allowance — see examples/agent-quickstart.mjs in the main repo for the two calls. Nothing in
// this SDK can raise that allowance on your behalf; only your own wallet can.

console.log(await agent.checkBalance());

await agent.payBill({
  pin: "1234",
  service: "AIRTIME",
  provider: "mtn",
  account_number: "08012345678",
  amount_ngn: 1000,
});
```

Reattach to a previously-minted key without signing again:

```ts
const agent = AbaPayAgent.fromApiKey(savedApiKey, walletAddress);
```

## Which one do I want?

|                          | `payBillViaX402`                  | `AbaPayAgent`                          |
| ------------------------ | ---------------------------------- | --------------------------------------- |
| Setup                    | None                                | One signed message, once                |
| Credential per call      | None — just the signature           | api_key + PIN, every payment            |
| Tool catalog             | Pay a bill, that's it               | Balance, history, schedules, batch, more |
| Best for                 | An external agent that already has a wallet and wants to pay, now | An agent that will call AbaPay repeatedly and wants the full catalog |

## Errors

Every failure — a bad request, a rejected signature, a settlement AbaPay itself reports as
unsuccessful — throws `AbaPayError` (`message`, and `response` carrying whatever AbaPay's API
returned, when there was a response to carry).

## License

MIT
