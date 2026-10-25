# Self Agent ID

AbaPay's MCP server, A2A endpoint and x402 endpoint accept a
[Self Agent ID](https://app.ai.self.xyz) as proof that a calling agent is backed by a real,
passport-verified human. A verified agent is **shown as verified** on every response. Agents
without one keep full access: Self is optional.

{% hint style="info" %}
**What it proves:** that a human completed a zero-knowledge passport check for the agent's key on
the [SelfAgentRegistry](https://celoscan.io/address/0xaC3DF9ABf80d0F5c020C06B04Cced27763355944) on
Celo (`0xaC3DF9ABf80d0F5c020C06B04Cced27763355944`). It never reveals *who* that human is.
{% endhint %}

## Sending it

Sign each request with the agent's EVM key and send three headers:

| Header | Value |
|---|---|
| `x-self-agent-address` | The agent's address (its key on the registry) |
| `x-self-agent-timestamp` | Unix time in **milliseconds** |
| `x-self-agent-signature` | Personal-message signature over the digest below |

The digest is

```
keccak256( timestamp + METHOD + path?query + keccak256(rawBody) )
```

for example `1793212345678` + `POST` + `/api/pay/x402` + `0x…` (the hash of the exact JSON body
you send). `abapay-sdk` (0.5.0+) signs for you: pass `selfAgent` to `payBillViaX402`, call
`agent.withSelfAgent(key)` for MCP, or set `SELF_AGENT_KEY` for the `abapay` CLI. Self's own SDK
(`@selfxyz/agent-sdk`, `SelfAgent`) signs requests the same way.

{% code title="Signing a request with viem" %}
```ts
import { keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const agent = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`)
const url = 'https://agents.abapays.com/api/pay/x402'
const body = JSON.stringify({ serviceID: 'mtn', serviceCategory: 'AIRTIME', billersCode: '08012345678', nairaAmount: 100, blockchain: 'CELO' })
const timestamp = String(Date.now())
const digest = keccak256(toBytes(timestamp + 'POST' + new URL(url).pathname + keccak256(toBytes(body))))

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-self-agent-address': agent.address,
    'x-self-agent-timestamp': timestamp,
    'x-self-agent-signature': await agent.signMessage({ message: { raw: digest } }),
  },
  body,
})
console.log(res.headers.get('x-abapay-self-agent')) // "verified; agent_id=…"
```
{% endcode %}

Each signature is valid for **5 minutes** and **one request**: sign every request afresh,
including the paid x402 retry.

## What you get back

Every response to a request that carried Self headers says what AbaPay found:

* **Header:** `X-AbaPay-Self-Agent: verified; agent_id=42` (or `expired`, `not_registered`, …)
* **x402 / REST JSON:** a `self_agent` object, e.g.
  `{ "status": "verified", "agent_id": "42", "agent_address": "0x…" }`
* **MCP / A2A (JSON-RPC):** the same object under `result._meta["abapay/self_agent"]`

The result is also stored with the payment, so AbaPay's records show which payments came from
Self-verified agents.

## Every case, and what happens

| The agent… | Can it pay? | `status` | Notes |
|---|---|---|---|
| sends no Self headers | ✅ Yes | — | Full access; simply not shown as verified. |
| is verified, with a fresh human proof issued by Self | ✅ Yes | `verified` | Shown as verified. |
| has a valid signature, but its proof **expired** | ✅ Yes | `expired` | Not shown as verified. The owner re-verifies at [app.ai.self.xyz](https://app.ai.self.xyz). |
| has a valid signature, but was **revoked** or never registered | ✅ Yes | `not_registered` | Not shown as verified. |
| is registered without a human proof | ✅ Yes | `no_human_proof` | Not shown as verified. |
| has a proof from a provider other than Self | ✅ Yes | `wrong_provider` | Not shown as verified. |
| sends a signature that doesn't check out: wrong body, stale timestamp, a different `x-self-agent-address`, reused, or incomplete headers | ❌ **Refused** | — | A claimed identity that can't be proven. Nothing is priced or charged. |
| AbaPay can't read the registry (RPC outage) | ✅ Yes | `unavailable` | Never blocks a payment. |

{% hint style="warning" %}
**The refusal:** x402 answers **HTTP 401** with
`{ "errorCode": "SELF_AGENT_INVALID", "error": "<reason> Nothing was charged.", "retryable": false }`.
MCP and A2A answer **HTTP 401** with JSON-RPC error `-32001` and the message
`SELF_AGENT_INVALID: <reason>`. Fix the signature, or send the request without Self headers.
{% endhint %}

Only secp256k1 (EVM) agent keys are supported today. A request marked
`x-self-agent-keytype: ed25519` is refused with the same error.

## AbaPay's own identity

AbaPay itself is registered under [ERC-8004 as agent #9687](https://8004scan.io/agents/celo/9687)
(see [Identity & discovery](identity.md)), and holds its own Self Agent ID on the
SelfAgentRegistry, backed by a passport proof of a real human. No personal data was disclosed:
only the proof is on-chain.

| | |
|---|---|
| Self agent ID | **#196** |
| Agent address | `0xDffF9AbaCcc4402D23cb856d0544bab622577A93` |
| Human owner | `0xec24bAfBc989a9bE5f6F0eAD8848753B5E4aE0B6`, the same wallet that owns ERC-8004 #9687 |
| Registered | 25 October 2026, [tx 0x31cd31f2…75a4](https://celoscan.io/tx/0x31cd31f264e25c6128af9b4eff63cd74c5b5d348d3633856c2dee371bf6b75a4) |
| Registry | [`0xaC3DF9AB…3355944`](https://celoscan.io/address/0xaC3DF9ABf80d0F5c020C06B04Cced27763355944) on Celo |

Check it yourself: `isVerifiedAgent` on the registry returns true for the agent address (left-padded
to 32 bytes), and `hasHumanProof(196)` and `isProofFresh(196)` return true.
