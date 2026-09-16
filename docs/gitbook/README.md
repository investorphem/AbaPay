# Introduction

{% hint style="success" %}
**[agents.abapays.com](https://agents.abapays.com)** — the live, interactive site this handbook documents. Every protocol, endpoint and contract address below is also demoed there with a real signing flow.
{% endhint %}

AbaPay is non-custodial stablecoin settlement infrastructure for real-world bills — airtime,
mobile data, electricity, cable, education — reachable by any agent that can hold a Celo
wallet or speak MCP. This handbook is the developer reference for building against it.

{% hint style="info" %}
An interactive version of this handbook (searchable sidebar, copyable code blocks) also lives as a published web app linked from [agents.abapays.com](https://agents.abapays.com). These Markdown files are the same content, kept here so the book has a real git history and syncs straight into GitBook.
{% endhint %}

## What this is, in one sentence

An agent turns an approved on-chain spend into a delivered real-world outcome — a phone topped
up, a meter recharged — through whichever rail fits it best: a structured tool call, a signed
HTTP challenge, or a wallet-linked conversation.

## What's actually missing in agent payments

Agent-payment infrastructure has converged on three shapes, and each stops short of the same
thing: an agent that can settle a payment but can't **complete an outcome**.

- **Crypto-native rails that stop at settlement.** x402, A2A, and similar protocols move a
  stablecoin from one wallet to another correctly — and then the transaction is the whole
  story. Nothing on the other end turns that transfer into a phone with airtime on it, or a
  meter that isn't about to cut power.
- **Real-world commerce APIs built for a human in the loop.** Card-based checkout, KYC gates,
  session cookies, a card-entry form — every one of these assumes a person is present to click
  through it. An autonomous agent, running unattended at 3am, cannot.
- **Custody as the price of automation.** The systems that do let an agent transact repeatedly
  and unattended mostly do it by holding the user's funds or a stored payment credential on
  their behalf — trading away non-custodial guarantees for convenience, rather than keeping
  both.

AbaPay is built at the seam those three leave open: a real x402, MCP, or A2A payment that
actually completes — airtime credited, a bill paid, a real result — with the wallet still
governed by an on-chain allowance the owner set and can revoke themselves, never a deposit or a
stored card. The agent gets a finished outcome; the human never has to trade custody for it.
See the [About](about.md) chapter for who operates this and where it's discoverable.

## Three ways in

<table data-view="cards">
  <thead>
    <tr>
      <th></th>
      <th></th>
      <th data-hidden data-card-target data-type="content-ref"></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>x402</strong></td>
      <td>Zero setup. Any agent with a Celo wallet calls the endpoint, gets a 402 challenge, signs, retries, settles. No account anywhere.</td>
      <td><a href="x402.md">x402.md</a></td>
    </tr>
    <tr>
      <td><strong>A2A / MCP</strong></td>
      <td>Structured tool calls. A linked wallet, an api_key, and a PIN, all set by API — never a browser.</td>
      <td><a href="a2a.md">a2a.md</a></td>
    </tr>
    <tr>
      <td><strong>Channels</strong></td>
      <td>Telegram and WhatsApp, AbaPay's own conversational agent identity, same execution engine underneath.</td>
      <td><a href="channels.md">channels.md</a></td>
    </tr>
  </tbody>
</table>

## Reference

| | |
|---|---|
| Live site | [agents.abapays.com](https://agents.abapays.com) |
| Repository (MIT) | [github.com/investorphem/AbaPay](https://github.com/investorphem/AbaPay) |
| TypeScript SDK | [npmjs.com/package/abapay-sdk](https://npmjs.com/package/abapay-sdk) |
| OpenAPI spec | [abapays.com/openapi.json](https://abapays.com/openapi.json) |

{% hint style="info" %}
**Celo-only, deliberately.** This handbook and the agent rails it documents run on Celo mainnet, end to end — every endpoint, contract address, and stablecoin here is Celo-scoped.
{% endhint %}
