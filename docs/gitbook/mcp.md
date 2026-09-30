# MCP

{% hint style="info" %}
**Local + remote** — the same protocol Claude and any MCP client speak.
{% endhint %}

10 tools over Streamable HTTP JSON-RPC. OAuth 2.1 is supported and preferred; an Agent Hub
API key remains the fallback for clients that can't do OAuth.

## Connect

{% code title="claude_desktop_config.json" %}
```json
{
  "mcpServers": {
    "abapay": { "url": "https://agents.abapays.com/api/mcp" }
  }
}
```
{% endcode %}

Claude Desktop / Code: Settings → Connectors → Add custom connector → paste the URL above.

## The 10 tools

| Tool | What it does |
|---|---|
| `describe_capabilities` | Human-readable menu of what AbaPay can pay and what's currently paused. |
| `check_balance` | The linked wallet's live balance, approved agent limit, and the vault's on-chain maximum for a single agent payment, per token, per chain. A bill above that maximum can't be paid through the API; it is refused before anything is sent. |
| `list_plans` | Real, currently purchasable DATA / CABLE / EDUCATION plans with exact variation codes. |
| `list_international_options` | Browses the international catalogue — country → product type → operator → priced plan. |
| `transaction_history` | Recent payments, paginated. |
| `pay_bill` | Pay one bill — airtime, data, electricity, cable, education, international. |
| `pay_bill_batch` | Up to 20 recipients under one PIN. |
| `schedule_bill` | Recurring or delayed payments. |
| `list_schedules` | What automations are currently set up. |
| `cancel_schedule` | Cancel one by `id` (no PIN), or several by `provider` / `all: true` (PIN required). |

## Retries never pay twice

`pay_bill`, `pay_bill_batch` and `schedule_bill` accept an optional `idempotency_key`: any
unique id you pick for that one payment, 8–128 characters (a UUID is ideal).

* **Retry with the same key** after a timeout and you get the first call's result back.
  Nothing is charged again. The key is remembered for 24 hours.
* **Same key, different arguments:** refused with a `409` conflict. Nothing is charged.
* **Same key while the first call is still running:** you're told it's in progress. Wait,
  then retry with the same key to get the result.
* **A call that failed before any money moved** (wrong PIN, invalid account, paused service)
  doesn't use the key up. Fix the request and retry with the same key.
* **No key:** an identical call within 2 minutes is treated as a retry of the first. To pay
  the same bill again on purpose within that window, pass a new key.

{% hint style="info" %}
**Same PIN rules as A2A.** MCP and A2A share one execution engine, one linking flow, and one PIN model — set entirely by API, never through a browser. See [A2A](a2a.md) for the exact request that does it.
{% endhint %}
