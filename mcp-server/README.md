# abapay-mcp-gateway

A standalone, **secret-free** MCP server for AbaPay — scoped to exactly the agentic surface,
not the consumer bill-pay app.

## Why this exists

AbaPay's real MCP server lives inside the main Next.js app (`src/app/api/mcp/route.ts`), which
means building it from scratch needs the whole consumer app's build — Supabase, VTpass, RPC
URLs, session secrets. That's the wrong thing to hand to a third-party automated build service
(Glama's server checks, for one), and it conflates two different concerns: the agent-facing
protocol surface and the consumer web app.

This package is the fix. The MCP **tool catalog** (`tools/list`) is static data — name,
description, JSON schema per tool — with zero database dependency, so it's served directly
from a tiny standalone server with **no npm dependencies at all** (Node's built-in `http`/
`https` only). The one method that genuinely needs the real backend, `tools/call`, is proxied
straight through to production over HTTPS. This gateway holds no credentials and no business
logic of its own — every PIN check, allowance, and kill switch is still enforced by the real
server on the other end of the proxy, exactly as it is for any other caller.

## Run it

```bash
npm start
# or
PORT=8080 node server.js
```

```bash
curl -X POST http://localhost:8080 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Docker

```bash
docker build -t abapay-mcp-gateway .
docker run -p 8080:8080 abapay-mcp-gateway
```

No `.env`, no secrets, no build step — the whole image is `node:20-slim` plus one file.

## Endpoints

| Method | What it does |
|---|---|
| `GET /health` | Liveness check |
| `POST /` (JSON-RPC) | `initialize`, `tools/list` — served locally. `tools/call` — proxied to `https://www.abapays.com/api/mcp` |

Full tool reference with prose descriptions: [agents.abapays.com/tools](https://agents.abapays.com/tools) and [/agents/mcp](https://agents.abapays.com/mcp).
