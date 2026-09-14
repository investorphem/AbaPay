# MCP

> Local + remote

10 tools over Streamable HTTP JSON-RPC — the same protocol Claude and any MCP client speak.
OAuth 2.1 is supported and preferred; an Agent Hub API key remains the fallback for clients
that can't do OAuth.

## Connect

```json
{
  "mcpServers": {
    "abapay": { "url": "https://www.abapays.com/api/mcp" }
  }
}
```

Claude Desktop / Code: Settings → Connectors → Add custom connector → paste the URL above.

## The 10 tools

| Tool | What it does |
|---|---|
| `describe_capabilities` | Human-readable menu of what AbaPay can pay and what's currently paused. |
| `check_balance` | The linked wallet's live balance and approved agent limit, per token, per chain. |
| `list_plans` | Real, currently purchasable DATA / CABLE / EDUCATION plans with exact variation codes. |
| `list_international_options` | Browses the international catalogue — country → product type → operator → priced plan. |
| `transaction_history` | Recent payments, paginated. |
| `pay_bill` | Pay one bill — airtime, data, electricity, cable, education, international. |
| `pay_bill_batch` | Up to 20 recipients under one PIN. |
| `schedule_bill` | Recurring or delayed payments. |
| `list_schedules` | What automations are currently set up. |
| `cancel_schedule` | Cancel one. |

## Same PIN rules as A2A

MCP and A2A share one execution engine, one linking flow, and one PIN model — set entirely
by API, never through a browser. See [A2A](a2a.md) for the exact request that does it.
