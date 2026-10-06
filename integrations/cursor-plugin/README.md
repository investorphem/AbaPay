# AbaPay for Cursor

Pay real-world bills from Cursor's agent with stablecoins: airtime, data, electricity, cable TV
and education in Nigeria, plus international airtime and data in 140+ countries. Payments settle
on-chain (Celo and Base) from a wallet you link once.

This plugin connects Cursor to AbaPay's remote MCP server:

```
https://agents.abapays.com/api/mcp   (Streamable HTTP)
```

## Tools

| Tool | What it does |
|---|---|
| `describe_capabilities` | What AbaPay can pay, and how to call each tool |
| `check_balance` | Your linked wallet's stablecoin balances |
| `list_plans` | Real plan codes for data, cable and education (required before paying those) |
| `list_international_options` | Country → product → operator → plan, for international top-ups |
| `pay_bill` | Pay one bill now (needs your PIN) |
| `pay_bill_batch` | Pay up to 20 airtime/data recipients at once (one PIN) |
| `schedule_bill` | Pay later, or on a recurring schedule (needs your PIN) |
| `list_schedules` / `cancel_schedule` | See and cancel scheduled bills |
| `transaction_history` | Your recent payments |
| `get_payment_status` | Where a payment is, by reference |

## Sign-in and safety

- **OAuth 2.1 with PKCE and Dynamic Client Registration.** On first use, Cursor opens AbaPay's
  consent page in your browser. You authorize once with your AbaPay agent key, and later sessions
  reconnect with a token.
- **Authorization never spends money on its own.** Every payment, batch and schedule still needs
  the PIN you set for your agent key, asked for on every single call. A token alone can only read
  a balance.
- **Bounded by your own on-chain allowance.** The agent can only spend what you approved for it in
  the AbaPay vault contract, per token, capped per payment.
- No secrets live in this plugin. It contains only the server URL.

## Install

From the Cursor Marketplace, install **AbaPay**, then sign in when Cursor prompts.

Or add the server yourself in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "abapay": { "url": "https://agents.abapays.com/api/mcp", "type": "http" }
  }
}
```

To try this plugin locally before it's published, copy this folder to
`~/.cursor/plugins/local/abapay`, then run **Developer: Reload Window**.

## Links

- Get an agent key and set your PIN: [abapays.com](https://abapays.com) → Agent Hub → MCP
- Developer docs: [docs.abapays.com](https://docs.abapays.com)
- Terms: [abapays.com/terms](https://abapays.com/terms) · Privacy: [abapays.com/privacy](https://abapays.com/privacy)
- Source (MIT): [github.com/investorphem/AbaPay](https://github.com/investorphem/AbaPay)
- Support: support@abapays.com
