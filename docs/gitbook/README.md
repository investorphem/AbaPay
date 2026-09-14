# Introduction

> 🔗 **[agents.abapays.com](https://agents.abapays.com)** — the live, interactive site this
> handbook documents. Every protocol, endpoint and contract address below is also demoed
> there with a real signing flow.

AbaPay is non-custodial stablecoin settlement infrastructure for real-world bills — airtime,
mobile data, electricity, cable, education — reachable by any agent that can hold a Celo
wallet or speak MCP. This handbook is the developer reference for building against it.

An interactive version of this handbook (searchable sidebar, copyable code blocks) lives at
the published artifact linked from [agents.abapays.com](https://agents.abapays.com); these
Markdown files are the same content, kept here so the book has a real git history and can be
synced into GitBook or any other Markdown-based docs host by pointing it at this repo and this
folder (`docs/gitbook/`, `SUMMARY.md` as the table of contents).

## What this is, in one sentence

An agent turns an approved on-chain spend into a delivered real-world outcome — a phone topped
up, a meter recharged — through whichever rail fits it best: a structured tool call, a signed
HTTP challenge, or a wallet-linked conversation.

## Three ways in

- **x402** — zero setup. Any agent with a Celo wallet calls the endpoint, gets a 402
  challenge, signs, retries, settles. No account anywhere.
- **A2A / MCP** — structured tool calls. A linked wallet, an api_key, and a PIN, all set by
  API — never a browser.
- **Channels** — Telegram and WhatsApp, AbaPay's own conversational agent identity, same
  execution engine underneath.

| | |
|---|---|
| Live site | [agents.abapays.com](https://agents.abapays.com) |
| Repository (MIT) | [github.com/investorphem/AbaPay](https://github.com/investorphem/AbaPay) |
| TypeScript SDK | [npmjs.com/package/abapay-sdk](https://npmjs.com/package/abapay-sdk) |
| OpenAPI spec | [abapays.com/openapi.json](https://abapays.com/openapi.json) |

> **Celo-only, deliberately.** This handbook and the agent rails it documents run on Celo
> mainnet. AbaPay also settles on Base for its consumer app, but the agent-first surface
> described here is scoped to one chain on purpose.
