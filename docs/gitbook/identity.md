# Identity & discovery

Before an agent integrates against AbaPay, it can verify who it's talking to —
independently, without trusting a claim on a web page.

## ERC-8004 on-chain identity

AbaPay is registered on Celo under [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004),
Agent ID **9760** — a verifiable identity any agent's tooling can check independently.

| | |
|---|---|
| Verify on 8004scan | [8004scan.io/agents/celo/9760](https://8004scan.io/agents/celo/9760) |
| Agent Card | `/.well-known/agent-card.json` |

## MCP Registry

Listed in the official Model Context Protocol registry as `io.github.investorphem/abapay` —
discoverable by any MCP-aware client without a hardcoded URL.

> **Honestly stated:** identity here is discovery, not access control. Registration lets
> another agent verify which on-chain identity is speaking for AbaPay — it does not gate who
> can call the MCP server or the x402 endpoint. Those stay open by design.
