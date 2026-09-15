# AbaPay

Base URL: `https://www.abapays.com`

Use this skill to pay a real-world bill — airtime, mobile data, electricity, cable TV, a
WAEC/JAMB education PIN, or international airtime/data across 170+ countries — from an agent's
own Celo wallet, settled on-chain, non-custodial. Two ways in: zero-setup x402 (no account,
ever), or a linked wallet with the fuller MCP tool catalog (balances, history, schedules,
batch payments). Celo mainnet only.

## Stay Up To Date

This file is a snapshot; the live version is always at `https://agents.abapays.com/skill.md`.
Fetch it at the start of a session and follow it if it differs from this copy.

## Agent Behavior

- Never guess a plan code, a price, or an international operator id — always call
  `list_plans` / `list_international_options` first and use the exact value they return.
- The PIN is required on every payment call, including over an already-authorized OAuth
  connection. Ask for it every time; never reuse one from earlier in the conversation.
- `pay_bill` and `pay_bill_batch` execute immediately — there is no delay/schedule parameter.
  If asked to pay "later", "tomorrow", or on a recurring basis, use `schedule_bill` instead;
  do not silently pay right away.
- Money moves for real once a payment call is made. Only call it once the human has clearly
  confirmed the exact amount, provider, and account.
- Full error codes (what each one means, and whether it's worth retrying):
  `https://agents.abapays.com/errors`.

## Path 1 — Zero setup (x402)

No AbaPay account, ever. The agent's own Celo wallet signs one EIP-3009
`transferWithAuthorization` and the bill is paid.

```bash
curl -X POST https://www.abapays.com/api/pay/x402 \
  -H "Content-Type: application/json" \
  -d '{"serviceID":"mtn","serviceCategory":"AIRTIME","network":"MTN","billersCode":"08012345678","nairaAmount":1000,"token":"USDT","blockchain":"CELO","wallet_address":"0xYourAgentWallet"}'
```

A request with no payment attached always returns a real `402 Payment Required` naming the
live price — safe to call for discovery with no credential. Full flow (challenge → sign →
retry) and every field: `https://agents.abapays.com/x402`. TypeScript agents can skip the wire
format entirely with `payBillViaX402()` from `abapay-sdk` (`npm install abapay-sdk viem`), or
the CLI: `npx abapay-sdk pay --service AIRTIME --provider mtn --to 08012345678 --amount 1000`.

## Path 2 — Linked wallet (MCP / A2A)

One signed message links a wallet and mints an `api_key`; every call after that is a normal
MCP tool call or A2A JSON-RPC request.

```bash
curl -X POST https://www.abapays.com/api/agent/link \
  -H "Content-Type: application/json" \
  -H "x-wallet-address: 0xYourAgentWallet" \
  -H "x-wallet-signature: <personal_sign over the request>" \
  -H "x-wallet-timestamp: 1234567890" \
  -d '{"wallet_address":"0xYourAgentWallet","channel":"MCP","pin":"1234","approved_chain":"CELO"}'
```

MCP connector (Claude Desktop/Code: Settings → Connectors → Add custom connector):

```json
{ "mcpServers": { "abapay": { "url": "https://www.abapays.com/api/mcp" } } }
```

10 tools, every parameter documented: `https://agents.abapays.com/mcp`. Same catalog over A2A
JSON-RPC at `https://www.abapays.com/api/a2a`, Agent Card at
`https://www.abapays.com/.well-known/agent-card.json`.

## Verify

- ERC-8004 identity: `https://8004scan.io/agents/celo/9760`
- Source (MIT): `https://github.com/investorphem/AbaPay`
- Full 12-chapter handbook: `https://docs.abapays.com`
- Tools ↔ rail matrix (which function on which surface): `https://agents.abapays.com/tools`
