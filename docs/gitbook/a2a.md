# A2A

{% hint style="info" %}
**Peer protocol** — no browser, no human account-creation step, for either side.
{% endhint %}

A peer agent discovers AbaPay via its Agent Card, then sends structured tool calls over A2A
JSON-RPC.

| | |
|---|---|
| Agent Card | `agents.abapays.com/.well-known/agent-card.json` |
| JSON-RPC endpoint | `agents.abapays.com/api/a2a` |

## Skills (10)

`describe_capabilities` `check_balance` `list_plans` `list_international_options`
`transaction_history` `pay_bill` `pay_bill_batch` `schedule_bill` `list_schedules`
`cancel_schedule`

## Can an agent set and use a PIN without visiting a website? Yes.

The PIN is a field in a JSON body, not something entered into a web form. Linking and every
payment after it are both plain API calls:

- `POST /api/agent/link` — a wallet-signature-authenticated call (the same `personal_sign`
  scheme x402 signing uses elsewhere) that picks the PIN *in that same request* and mints an
  Agent Hub api_key back. One HTTP call, no session, no browser.
- Every `pay_bill` / `pay_bill_batch` / `schedule_bill` call after that sends the same PIN
  back as another JSON field — still just an HTTP request.

{% code title="POST /api/agent/link — real fields, verified live" %}
```
headers: {
  "x-wallet-address": "0xYourAgentWallet...",
  "x-wallet-signature": "<personal_sign over the request>",
  "x-wallet-timestamp": "1234567890"
}
body: {
  "wallet_address": "0xYourAgentWallet...",
  "channel": "MCP",
  "pin": "1234",
  "approved_chain": "CELO"
}
-> { "success": true, "api_key": "aba_mcp_..." }
```
{% endcode %}

Full runnable version: [examples/agent-quickstart.mjs](https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs).
Or skip the wire format entirely: `AbaPayAgent.link()` in [the SDK](sdk.md) does this in one
line.

{% hint style="warning" %}
The PIN itself is still real security, not a formality: it's the one thing separate from the signature that has to be right on *every* payment call — unlike x402, which needs neither a PIN nor a link step at all. Two different trust models, both entirely API-driven.
{% endhint %}
