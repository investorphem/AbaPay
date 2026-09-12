# Agent Integration Guide

**Audience:** an autonomous agent (or the developer wiring one up) that wants to use AbaPay's
payment rails *as infrastructure* — no human opening a browser, no visiting abapays.com, no
clicking through the app. Every step below is a plain HTTP call or an on-chain transaction an
agent's own wallet client can make by itself.

This is the missing piece between "the code supports headless agents" and "that's documented
anywhere" — everything here already exists and ships today; this file just writes it down in
one place, as its own reproducible example, separate from the human-facing app walkthrough in
[`README.md`](../README.md) and [`/docs`](../src/app/docs/page.tsx).

**Want to just run it?** [`examples/agent-quickstart.mjs`](../examples/agent-quickstart.mjs) is
every step below as one script — `PRIVATE_KEY=0x... node examples/agent-quickstart.mjs` mints
an API key, sets an on-chain allowance, and calls `check_balance`, against production. Its
wallet-signature auth and MCP call are verified live (see the file's own header); this prose
walkthrough is for when you want to understand each step, not just run it.

There are two separate rails. Pick based on what kind of agent you are.

---

## Path 1 — x402: zero setup, pay-per-call

If your agent already holds a funded wallet and just wants to pay one bill, there is **no
account, no API key, no signup step at all.** Call the resource server, get a `402` challenge
back, sign an EIP-3009 `transferWithAuthorization` for the exact amount requested, retry with
an `X-PAYMENT` header. This is the same rail described in `src/lib/x402Pay.ts` and
`src/app/api/pay/x402/route.ts` (see also `ENV_SETUP.md` §5/§5b for the two facilitators —
Celo's own, and Base via Coinbase's CDP, the one that also feeds the x402 Bazaar catalog).

This is the genuinely zero-integration path: any x402-aware agent (Paybox, or your own code
using any x402 client library) can discover and pay through it without AbaPay ever being told
it exists in advance.

---

## Path 2 — MCP tool calls (`pay_bill`, `schedule_bill`, `check_balance`, …): headless self-service onboarding

The MCP tool-call rail is account-scoped (it's the same execution engine behind
WhatsApp/Telegram/X, with the same PIN gate and on-chain spending ceiling protecting whoever's
wallet it's acting for). "Account-scoped" does **not** mean "requires a browser" — the whole
signup happens over plain HTTP, authenticated by a wallet signature your agent produces itself.

### Step 1 — Prove wallet ownership and mint an API key

No session, no cookie, no CAPTCHA — just an ECDSA signature (EOA) or ERC-1271 signature (smart
contract wallet: Coinbase Smart Wallet / Base Account, Safe, etc.), verified server-side in
`src/utils/walletAuth.ts`.

Sign this exact message with the wallet that will hold the AbaPay spending allowance:

```
AbaPay Agent Action: POST:/api/agent/link: <unix-ms-timestamp>
```

Then:

```http
POST /api/agent/link
Content-Type: application/json
x-wallet-address: 0xYourAgentWallet
x-wallet-signature: 0x...           # signature over the message above
x-wallet-timestamp: <same timestamp, must be within 5 minutes>

{
  "wallet_address": "0xYourAgentWallet",
  "channel": "MCP",
  "pin": "1234",                    # 4-6 digits, YOU choose it, YOU remember it
  "approved_chain": "CELO",         # or "BASE"
  "approved_token": "USD₮",         # or "USDC" / "USA₮"
  "mcp_key_label": "my-agent"       # optional, for your own bookkeeping
}
```

Response:

```json
{
  "success": true,
  "api_key": "aba_mcp_...",
  "instructions": "Save this API key now — it will not be shown again."
}
```

That key is shown exactly once. Store it yourself; there is no recovery flow other than
minting a new one the same way. This is a plain `INSERT`, not tied to any human session — the
signature *is* the identity proof. `PATCH`/`DELETE` on the same endpoint (reset PIN, unlink)
work the same way: sign `PATCH:/api/agent/link` or `DELETE:/api/agent/link` respectively.

### Step 2 — Authorize on-chain spending

The API key alone authorizes nothing — it identifies your agent to the backend, but the actual
spending ceiling is enforced **on-chain**, by the contract, not by AbaPay's servers. Two calls,
from the same wallet, against `AbaPayV3`/`AbaPayV4`
(`NEXT_PUBLIC_ABAPAY_CELO_ADDRESS` / `NEXT_PUBLIC_ABAPAY_BASE_ADDRESS` — the deployed addresses
are in your `.env`/Vercel config; the ABI is in this repo's `typechain-types/` and
`contracts/AbaPayV4.sol`):

1. Standard ERC-20 `approve(abapayContractAddress, amount)` on the stablecoin contract — lets
   the contract move the tokens at all.
2. `setSpendingAllowance(tokenAddress, amount)` on the AbaPay contract itself — the actual cap
   the relayer is bounded by. **Only the wallet itself can call this for itself** — there is no
   owner/relayer function that raises someone else's allowance, specifically so a compromised
   backend can never grant itself more room (see `contracts/AbaPayV4.sol`, `setSpendingAllowance`).

Both are ordinary contract calls any wallet client (viem, ethers, web3.py, whatever your agent
runtime uses) can make directly — nothing here requires the AbaPay frontend.

### Step 3 — Call MCP tools with the API key, no OAuth needed

`POST /api/mcp` per the standard MCP `tools/call` shape, passing `api_key` as a tool argument
(`check_balance`, `pay_bill`, etc. all accept it). OAuth 2.1 exists as the *preferred, nicer*
flow for a human authorizing an agent inside a chat client like Claude.ai, but it was never the
only way in — `api_key` has worked standalone the whole time, which is exactly what makes this
whole path headless. The PIN from Step 1 is required on every `pay_bill`/`pay_bill_batch`/
`schedule_bill` call, same as every other channel.

---

## Settlement, Custody & Compliance

### Non-custodial by construction, not just by claim

AbaPay never takes custody of funds ahead of a payment. There is no deposit step, no pooled
balance held on your behalf. The contract (`contracts/AbaPayV4.sol`, functionally identical to
`AbaPayV3.sol` on the parts below) uses a pull-based ERC-20 allowance, and every constraint is
enforced **on-chain**, not by application code that could be bypassed by hitting the API
directly:

- `payBillFor` (the function the relayer calls) reverts if `amount` exceeds either the
  per-token, per-transaction ceiling (`maxAgentPaymentPerTx`, owner-set) **or** the caller's own
  remaining `spendingAllowance` — both checked before anything moves.
- The allowance is decremented *before* the token transfer (checks-effects-interactions), so a
  reentrant call can't double-spend the same allowance.
- Tokens move directly from the payer's wallet to the settlement contract in the same
  transaction that decrements the allowance — there is no intermediate AbaPay-controlled
  balance for them to sit in.
- `setSpendingAllowance` can only ever be called by the wallet setting its own allowance. There
  is no path — not even an owner/admin one — for AbaPay's backend to grant itself more room on
  anyone's account.

This matches the framing already published at [`/terms`](https://www.abapays.com/terms):
AbaPay operates as a **non-custodial software protocol / technology interface**, not a
custodian, and has no access to any wallet's private keys. (`/terms` also covers AML
monitoring — SCUML/SEC Nigeria/FATF-aligned transaction monitoring — and is explicitly *not*
represented as lawyer-reviewed; read it directly rather than this summary for anything you
need to rely on legally.)

### The off-chain leg: how a stablecoin payment becomes a delivered bill

The on-chain payment and the off-chain vend are two separate steps, bridged by a webhook, not a
synchronous call:

1. The stablecoin payment lands on-chain (contract call or x402 settlement).
2. AbaPay's backend, triggered by the on-chain event, calls **VTpass** — the licensed Nigerian
   bill-aggregation API this whole product vends through (airtime, data, electricity, cable,
   education, and VTpass's live international airtime/data catalogue) — to actually deliver the
   purchase.
3. If vending fails *after* the on-chain payment already confirmed, the transaction is marked
   `FAILED_VENDING` (see the MCP receipt card's own status handling) and enters an **automatic
   refund flow**: flagged, verified against what actually happened, and refunded on-chain to
   the payer's wallet without a human needing to intervene (manual refund tools also exist in
   the admin dashboard as a backstop, capped per-token on-chain via `setMaxRefund` — refunds
   revert until a cap is configured, so this can't be an unbounded drain either).

An agent integrating against this should treat `PENDING` and `FAILED_VENDING` as real, expected
outcomes with money already moved — not errors to retry blindly (retrying a already-settled
payment double-charges the wallet; see the extensive handling of this exact failure mode in
`src/lib/x402Pay.ts` and `src/app/api/pay/x402/route.ts`).

### Kill switches (all of them stop the agent, not just the UI)

- **Per-channel pause**: `isChannelEnabled('MCP')` (or WHATSAPP/TELEGRAM/X) in
  `src/lib/serviceRules.ts` — an operator can pause just the MCP surface without touching chat.
- **Global pause**: `pause()` on the contract (`Pausable`) — `payBill`/`payBillFor` both revert
  while paused; refunds deliberately stay callable so anyone already charged can still be made
  whole.
- **Relayer kill switch**: `setRelayer(address(0))` instantly disables the *agent-initiated*
  path (`payBillFor`) system-wide, on-chain, independent of anything the backend does — a
  compromised backend cannot re-enable itself.
- **Per-agent-credential rate limiting**: every money-moving MCP call (`pay_bill`,
  `pay_bill_batch`, `schedule_bill`) is rate-limited per API key, on top of the PIN requirement.
- **PIN lockout**: escalating lockout on repeated failed PIN attempts
  (`failed_pin_attempts`/`locked_until` on the same `agent_links` row Step 1 creates).

None of these live only in the web app — they're enforced by the same code path (or the
contract itself) regardless of which channel or credential is calling in, MCP included.

---

## Reference

| What | Where |
|---|---|
| MCP transport | `src/app/api/mcp/route.ts` |
| MCP tool definitions & handlers | `src/lib/deai/mcpTools.ts` |
| Headless wallet-signature auth | `src/utils/walletAuth.ts` |
| Agent linking / API key minting | `src/app/api/agent/link/route.ts` |
| x402 resource server | `src/app/api/pay/x402/route.ts`, `src/lib/x402Pay.ts` |
| Settlement contract (current) | `contracts/AbaPayV4.sol` (ABI: `typechain-types/`) |
| Off-chain vendor integration | VTpass (see `README.md` for the full provider list) |
| OpenAPI reference | `public/openapi.json` |
| Legal entity | Masonode Technologies Limited, CAC RC 9524980 (see `README.md` §Legal Entity) |
