# AbaPay on Celo — Dune dashboard

**Dashboard:** https://dune.com/abapay/abapay-on-celo (dashboard id `220131`) — live as of
2026-09-11.

The SQL behind the **Celo-only** public dashboard on the `abapay` Dune team. Mirrors
[`dune/base-chain/`](../base-chain/) exactly — same architecture, same reasoning for almost
every decision — pointed at Celo mainnet instead of Base. Read that directory's README first;
this one only calls out what's actually different for Celo.

## The one real difference: the rail split stays live

Base retired `15_by_rail.sql` (agent vs direct wallet) as "too internal for the audience that
dashboard is published for." **This dashboard keeps its equivalent, `12_by_rail.sql`, live and
numbered near the top** — it's the metric that actually answers "how much of this is agents,
not humans clicking Pay," which is the whole point of a dashboard meant to show reviewers
(Prezenti's Frontier pool, among others) that AbaPay is reusable agent-payment infrastructure,
not just a consumer app. `14_by_service.sql` and `15_by_contract.sql` are retired here for the
same reason Base retired its equivalents — see that README's own reasoning, it applies
unchanged.

## Three tokens, not two

Celo accepts **USD₮, USDC, and USA₮** — Base only ever offered USDC/USD₮. All three are
6-decimal and dollar-pegged, so `amount_usd` stays a straight scale (see
`TOKEN_ORDER_BY_CHAIN.CELO` in `src/constants/index.ts`).

## The date floor was verified, not copied from Base

Base's root query floors at `2026-04-01` because that's a month of buffer before its first
real payment (`2026-05-01`). Celo is the **original** chain — AbaPay launched here before
Base — so that floor would be wrong; an *unfloored* probe query against `celo.logs` for these
two contract addresses actually **timed out** at the free tier's 2-minute ceiling, which is
its own data point about how much more chain history sits before AbaPay existed here than on
Base. A follow-up probe with `block_date >= '2026-01-01'` found the real first contract-call
payment: **2026-07-18 09:55:06 UTC** (85 logs as of 2026-09-11). `2026-07-01` is that date
minus ~17 days of buffer. If this ever looks like it's clipping real x402 history from before
the contract-call rail existed, re-run the same kind of probe rather than assuming the floor
is still right — don't just copy Base's `2026-04-01`, it isn't verified for this chain.

## Two contracts, same reasoning as Base

| Address | Contract |
|---|---|
| `0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C` | AbaPayV4 — current |
| `0x42Fa463798Ed129a9B5Ee51721CB6db1bfCBe3b9` | AbaPayV3 — original |

Configured via `ABAPAY_CELO_CONTRACTS` in `.env.local` (`address=label`, comma-separated), not
hardcoded in the SQL — see `scripts/dune-celo-setup.mjs`.

## How this dashboard was actually first stood up

Unlike Base's dashboard (deployed via `scripts/dune-base-setup.mjs` and the REST API, with a
documented 402/403 fallback for plans that don't allow query CRUD over the API), this one was
stood up **directly through the Dune MCP server** in one session on 2026-09-11 — creating,
executing, and materializing every query, then assembling the dashboard, all as live MCP tool
calls rather than the REST script. That's a second, independent path to the same result;
`scripts/dune-celo-setup.mjs` still exists and still works the same way `dune-base-setup.mjs`
does; use whichever is more convenient the next time these queries need to change. If the REST
path 402/403s on this account the way Base's README describes for its era, the MCP path is a
proven working alternative — worth knowing given account/plan behavior has already changed
once mid-project (see the `PERFORMANCE` note in `src/app/api/cron/dune-refresh/route.ts`).

## Layout

| File | Query | Panel? |
|---|---|---|
| `00_events.sql` | Root — decoded payments + rail | — (matview only) |
| `10_kpi_summary.sql` | All-time KPIs | ✅ |
| `11_daily_volume.sql` | Daily volume & tx, cumulative line | ✅ |
| `12_by_rail.sql` | Agent vs Direct vs x402, daily | ✅ — kept live, see above |
| `13_by_token.sql` | USD₮ vs USDC vs USA₮ | ✅ |
| `14_by_service.sql` | Airtime / data / electricity / TV … | retired (`is_temp`) |
| `15_by_contract.sql` | V3 vs V4 split | retired (`is_temp`) |
| `16_dau_wau.sql` | DAU / WAU / MAU | ✅ |
| `17_new_vs_returning.sql` | New vs returning payers, daily | ✅ |

Root query reads `celo.logs` and `erc20_celo.evt_transfer`; every dependent reads
`dune.abapay.result_abapay_celo_events` (the matview), never the root query directly — same
`query_<id>`-is-a-view trap Base's README documents, and the same regression guard in
`scripts/dune-celo-setup.mjs` refuses to deploy a dependent that gets this wrong.

## Refresh

Identical two-layer split to Base's — see that README's "Refresh" section for the full
explanation. Summary:

| Layer | What keeps it fresh | When |
|---|---|---|
| **Data** — `dune.abapay.result_abapay_celo_events` | Dune's own matview cron | 02:00 UTC daily |
| **Panels** — the 6 live dependent queries | `/api/cron/dune-refresh?dashboard=celo`, from `.github/workflows/dune-refresh.yml` | 03:15 UTC daily |

## Privacy

Same as Base: `PaymentReceived` carries an `accountNumber` (meter/phone/bill account) that is
customer PII. It is **deliberately not decoded** into any column here.

## Deploying a change

```bash
node scripts/dune-celo-setup.mjs --dry-run   # render everything, call nothing
node scripts/dune-celo-setup.mjs             # create or update, then verify by running them
```

Requires `ABAPAY_CELO_CONTRACTS` and `DUNE_API_KEY` in `.env.local`. Edit the SQL **here**,
never in the Dune web editor or by asking an agent to patch the live query directly without
updating this file first — a change that isn't reflected here makes this directory silently
wrong with no way to diff it.

## What is on the dashboard

Built via the Dune MCP server's `generateVisualization` + `createDashboard` (see "How this
dashboard was actually first stood up" above) — the same mechanism `dune/base-chain/README.md`
documents, in one session rather than the browser.

| Widget | Query | Visualization |
|---|---|---|
| Total Volume (USD), Total Transactions, Total Users | `10_kpi_summary.sql` | 3 counters |
| **Agent vs Direct vs x402 Rail (Volume)** | `12_by_rail.sql` | Stacked column, by day — **placed first**, per this dashboard's whole reason for existing |
| Daily Volume & Cumulative Total | `11_daily_volume.sql` | Line, dual axis |
| Volume by Token | `13_by_token.sql` | Pie |
| DAU / WAU / MAU | `16_dau_wau.sql` | Line, 3 series |
| New vs Returning Payers | `17_new_vs_returning.sql` | Stacked column |
| KPI Summary (full detail) | `10_kpi_summary.sql` | Table |

`14_by_service.sql` and `15_by_contract.sql` are deployed and queryable but have no widget —
retired, per the RETIRED set in `scripts/dune-celo-setup.mjs`.
