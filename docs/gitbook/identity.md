# Identity & discovery

Before an agent integrates against AbaPay, it can verify who it's talking to —
independently, without trusting a claim on a web page.

## ERC-8004 on-chain identity

AbaPay is registered on Celo under [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004),
Agent ID **9687** — a verifiable identity any agent's tooling can check independently.

| | |
|---|---|
| Verify on 8004scan | [8004scan.io/agents/celo/9687](https://8004scan.io/agents/celo/9687) |
| Agent Card | `/.well-known/agent-card.json` |

## MCP Registry

Listed in the official Model Context Protocol registry as `io.github.investorphem/abapay` —
discoverable by any MCP-aware client without a hardcoded URL.

## agent402.tools

AbaPay's x402 endpoint is indexed on [agent402.tools](https://agent402.tools/api/index?seller=agents.abapays.com),
an open index of x402 sellers. It found us through the `/.well-known/x402` manifest on
`agents.abapays.com` and re-crawls the live 402 challenge for price, networks and assets.

## Cursor

Listed as a Cursor plugin at [cursor.directory/plugins/abapay](https://cursor.directory/plugins/abapay). Installing it
adds AbaPay's MCP server to Cursor, which then runs the OAuth sign-in in your browser. The
plugin's source is `integrations/cursor-plugin/` in the repo.

{% hint style="warning" %}
**Honestly stated:** identity here is discovery, not access control. Registration lets another agent verify which on-chain identity is speaking for AbaPay — it does not gate who can call the MCP server or the x402 endpoint. Those stay open by design.
{% endhint %}
