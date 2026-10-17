# Runbooks

One section per signal: what it means, how to confirm it, what to do. The live state of every
component is at `GET /api/admin/health` (admin session required). It returns `components`, each
`ok | warn | down` with the number behind it.

## A cron stopped (dead-man alert from healthchecks.io / Better Stack)

**Means:** a job didn't ping on time (`/api/cleanup`, `/api/schedules/run`,
`/api/schedules/run-instant` or `/api/cron/onchain-index`). A `/fail` ping means it ran and failed.

**Check:** the scheduler (cron-job.org or the GitHub workflow) is enabled, and its `CRON_SECRET`
matches Vercel's. A 401 or 503 from the route means a secret problem. Then open the run in the
Vercel logs.

**Do:** re-run the job by hand with the secret. Until `/api/cleanup` runs, stuck payments and x402
intents aren't reconciled, and until `/run-instant` runs, one-off schedules don't fire.

## Fulfilment job needs review (Telegram "FULFILMENT JOB NEEDS REVIEW")

**Means:** a proven payment is still unresolved after 8 worker attempts (`fulfilment_jobs.status = 'needs_review'`, reason in `last_error`). The worker has stopped retrying it.

**Check:** the transaction's row and the provider's own record of its `request_id` (requery from `/admin`).

**Do:** settle it by hand: complete it if the biller delivered, or refund it if it failed. Then set the job to `done`. The worker never re-sends a payment it can't prove was unsent, so a parked job is never a double-delivery risk.

## Refund backlog (`refunds_pending`, `refund_age_max_hours`)

**Means:** a paid order failed to deliver and its refund is waiting for an operator.
`components.refunds` turns `warn` after 72 hours.

**Check:** the Ops panel in `/admin`, Refunds tab.

**Do:** fund the vault if it can't cover the refunds, then release them. The vault owner wallet
signs `refundUser`; the ops admin wallet can't.

## Payments with no known outcome (`unknown_outcome_rows`)

**Means:** rows still `PROCESSING` more than 30 minutes after payment. The biller accepted the
order but hasn't confirmed delivery, or didn't answer.

**Check:** `/api/cleanup` is running (the reconciler requeries VTpass), and VTpass's status page.

**Do:** requery from the admin dashboard. Never mark a row delivered or refunded by hand without
the biller's answer.

If VTpass has no record of the request (requery code `015`, INVALID REQUEST ID), the order never
reached them: nothing was delivered and nothing can be later. Check Status says so, the sweep sends
"VTPASS HAS NO RECORD" once, and the row shows the reason. Refund it from the row.

## Unresolved x402 payments (`x402_intents_unresolved`)

**Means:** an x402 intent recorded more than 15 minutes ago that is neither settled nor closed.
Usually the request died mid-settle.

**Do:** run `/api/cleanup`. The x402 reconciler asks the token whether the authorization was
spent, then finishes it or closes it. Persistent rows point at the RPC or the facilitator.

## A provider breaker is open (`components.provider_circuits` = `down`)

**Means:** VTpass (error 018) or Monnify (D04) reported an empty float, and that provider's
services are refused before payment.

**Do:** top up the provider float. The breaker closes by itself once the balance check passes,
or use `RESET_PROVIDER_CIRCUIT` in the admin actions.

## Delivery failures climbing (`vend_outcome_total{outcome="FAILED_VENDING"}`)

**Means:** paid orders are failing at the biller. Each one becomes a refund.

**Check:** float balances in `/admin`, and the error codes on the failed rows.

**Do:** if it's the float, top it up (the breaker should already have paused sales). Otherwise,
pause the affected service with its kill switch.

## Payment checks failing (`payments_verified_total{result!="ok"}`)

**Means:** a payment proof didn't verify.

- `NOT_FOUND` / `RPC_UNAVAILABLE`: usually the chain RPC. Check the RPC provider.
- `WRONG_*`: the transaction doesn't match the order, which is tampering or a client bug.

Look at the rows' `error_code`.

## Facilitator slow or failing (`facilitator_settle_latency_ms`, status ≠ 200)

**Means:** the x402 facilitator is slow or refusing settlements.

**Check:** the facilitator's `/health`. On Celo, also check credits on x402.celo.org, because an
empty credit balance fails every settlement with a 402.

**Do:** top up credits. If the facilitator is down, payers can still pay through the in-app
contract-call rail.

## Relayer gas low (`relayer_gas_balance`, Telegram "RELAYER GAS LOW")

**Means:** the relayer that sends agent and scheduled payments is low on CELO / ETH.

**Do:** send native gas to the relayer address in the alert. It needs gas only, never tokens.

## Supporting a developer whose agent paid (x402, MCP, A2A)

**Find the payment:** Admin → Ledger. Search the request ID, tx hash or wallet. You can also
search the agent's name ("earmark") or its ERC-8004 ID ("9806"). Every x402, MCP and A2A row has
an agent badge under the wallet. Click it for the detail. Our own Telegram/WhatsApp/X agent rows
don't have one.

**Reading the badge.** Facts come from the chain; claims come from the request:

| Badge / line | Kind | Means |
|---|---|---|
| `🤖 Name #9806` | fact | The paying wallet owns ERC-8004 agent 9806, or the registry names it as that agent's wallet. Name, description, site and x402 endpoint are what the developer registered. 8004scan links to it. |
| `No ERC-8004 identity` | fact | The wallet has no agent identity. You only know the wallet. |
| `Self ✓` | fact | A Self Agent ID: a passport-verified human is behind the agent. It says **that** there is a person, never **who**. |
| `Self ⚠ stale` / `Self ✗` / `Self ?` | fact | Proof expired / not registered / the registry couldn't be read (retried next payment). |
| `MCP` / `A2A`, "via … · OAuth client “Claude”" | claim + fact | How the client connected. The wallet is a linked AbaPay user who approved with their PIN. The OAuth client name is what the client registered itself as. |
| name, ERC-8004 id, UA | claim | `X-Agent-Name`, `X-Agent-Id` and User-Agent as the request sent them. "✗ not this wallet's" means the declared ID doesn't belong to the payer. |
| `Agent: not looked up yet` | — | Paid before this existed, or the lookup hasn't run yet (it runs just after the payment). |

**Contacting the developer:** use the site in the agent's ERC-8004 entry, or its 8004scan page.
For MCP/A2A, the wallet belongs to a registered user. Their linked phone or messaging account is
on the same row and under Identity. AbaPay never learns a Self-verified person's name.

**Answering them:** state what moved on-chain (tx hash), what VTpass did (Check Status), and
what we did about it (refund hash). If their agent resubmitted a payment, tell them the same
signed header is answered from the first attempt. Ask them to send `X-Agent-Name` and
`X-Agent-Id` (docs/gitbook/x402.md) if the badge shows no identity.

None of this is shown on receipts or any public page (migration 044; only `/api/admin/data`
reads it).
