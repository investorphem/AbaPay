# Changelog

{% hint style="info" %}
Curated, not a raw PR dump — internal chores, reverted debug logging, and pure
test-tooling fixes are left out. Full history: [commits on
GitHub](https://github.com/investorphem/AbaPay/commits/main).
{% endhint %}

## 2026-09-29

* **x402 records every payment before any money moves.** The payment is written down before
  the facilitator is asked to settle, so a settlement can no longer happen with no record of it.
  An interrupted request is finished (or closed, if the authorization expires unspent) by a
  background reconciler that asks the token whether the authorization was spent.
* **x402 settlements are confirmed on-chain before delivery.** The facilitator's reply alone no
  longer triggers a vend: the token's own `Transfer` log (payer to vault, full amount) must be
  in the reported transaction. A settlement the chain can't confirm yet returns `202` with
  `verifying: true`. Don't pay again. See [What the retry can answer](x402.md#what-the-retry-can-answer).
* **Unpayable x402 requests are refused before settlement.** A request with no bill details, or
  signed by a different wallet than its `wallet_address`, now gets a `400` and is never charged.
  Previously it was settled and refunded.
* **The web app's payment check is stricter.** The web app's contract-call payments are now
  verified against the vault's own `PaymentReceived` event (token, amount, account, service and
  payer), and the bill delivered is the one stored when the payment was started.

## 2026-09-23

* **x402 challenge carries a `hint` field.** A wallet that can sign EIP-3009 but has no client
  driving the challenge/sign/retry sequence now gets pointed at the ordinary guided flow
  (abapays.com, no x402 required) instead of a bare 402 with nowhere to go.

## 2026-09-21

* **Dedicated rate-limiting documentation.** Every rate-limited scope (MCP/A2A, OAuth,
  agent-link, chat, verification, Monnify, schedules) now has one canonical table — see [Rate
  limits](rate-limits.md) — instead of partial numbers scattered across call sites.
* **Listed on `awesome-mcp-servers`** (95k+ stars) under Finance & Fintech.

## 2026-09-19 — 2026-09-20

* **Homepage stat bar expanded into a fuller infrastructure dashboard.**
* **Agent-facing metadata domain canonicalized**, SDK domain defaults fixed.
* **MCP now accepts a Bearer-header `api_key`**; stale consumer-app MCP URL fixed.

## 2026-09-17 — 2026-09-18

* **x402 vends only after verifying the meter/smartcard/bank/JAMB account**, closing a gap
  where a bad-but-plausible account number would settle before the check.
* **MCP Playground listing** added to the discovery table.
* **Fees reconciled across MCP, chat, and x402** — the x402 facilitator fee now moves to
  admin-configurable, charged to the payer, with USD led in agent responses.
* **USA₮ mentioned everywhere USDC/USD₮ already were.**

## 2026-09-14 — 2026-09-16

* **`agents.abapays.com` migration completed** — the agent-first front door, Celo-only, fully
  separated from the consumer app. Stdio MCP gateway added; old deploy scripts retired.
* **ERC-8004 agent ID corrected** on the site after the migration.
* **12-chapter GitBook handbook published** at docs.abapays.com, linked into nav and footer.
* **`abapay-sdk` published to PyPI** (Python) — registry submissions in review at the time.
* **Real tool tables, live playgrounds, error codes, and a CLI** added to the agent site.

## 2026-09-11 — 2026-09-13

* **`abapay-sdk` (TypeScript) shipped to npm** — `payBillViaX402()` and `AbaPayAgent`, the two
  functions this handbook's [SDK chapter](sdk.md) documents.
* **Standalone Celo-only agent site redesign** — x402 headline, A2A, single footer, live hero
  stats read from Dune instead of hardcoded.
* **AbaPay listed on the official MCP Registry** as `io.github.investorphem/abapay`.
* **Multi-recipient batch payments** (`pay_bill_batch`) and **per-identity rate limiting** on
  spend actions shipped together.
* **Critical Next.js dependency bump** (unauthenticated RCE fix), same window.

## 2026-09-04 — 2026-09-08

* **Interactive MCP Apps cards** (SEP-1865) for receipts, history, and batch payments, with
  paginated history and `listChanged`/SSE support.
* **Exact-amount token approvals** and a proactive insufficient-balance warning on the web
  wallet flow.
* **Masonode corporate landing page** at `app.abapays.com` for Monnify KYB.

---

Earlier history — Dune dashboards, the A2A server, refund reconciliation, and the initial x402
wallet routing — is on [GitHub](https://github.com/investorphem/AbaPay/commits/main).
