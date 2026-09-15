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
**Celo-only, deliberately.** This handbook and the agent rails it documents run on Celo mainnet. AbaPay also settles on Base for its consumer app, but the agent-first surface described here is scoped to one chain on purpose.
{% endhint %}
