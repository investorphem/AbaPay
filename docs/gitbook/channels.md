# Channels

{% hint style="info" %}
**Telegram & WhatsApp — conversational.** Not a structured protocol — see the note below.
{% endhint %}

Before it was reachable by MCP, A2A, or x402, AbaPay was already an agent — a
natural-language identity, not a protocol endpoint. Every payment it makes on these channels
runs through the exact same allowance-bounded execution engine as every other rail in this
handbook.

| | |
|---|---|
| Telegram | [@AbaPays](https://t.me/AbaPays) |
| WhatsApp | [+234 707 541 8792](https://wa.me/2347075418792) |

## What this is — and isn't

This is **AbaPay's own agent identity** — the same one registered on-chain under ERC-8004 —
reachable in plain language. A human types "pay 1000 naira MTN airtime to 08012345678" and it
understands intent, not menu numbers. Nothing here is a separate system: it's the identical
execution pipeline behind MCP and A2A, just with a chat interface in front of it.

The PIN here works the same way as everywhere else in this handbook — set inside the
conversation itself ("Reply with your PIN to set it up"), never through a web form.

What this **isn't**: a structured, machine-typed protocol. A program that wants to drive
these channels has to speak natural language the way a human would, rather than calling a
typed function — which is exactly why x402, A2A and MCP exist as separate, structured rails
for agent-to-agent integration. Use this chapter to understand AbaPay as an agent in its own
right; use those three to integrate one.
