# AbaPay on Base — Dune dashboard

**Dashboard:** https://dune.com/abapay/abapay-on-base (dashboard id `217982`)

The SQL behind the **Base-only** public dashboard on the `abapay` Dune team. This directory is
the source of truth: the copies living on dune.com are deployed from here.

## ⚠️ Charts can only be created in the Dune web UI

**The dashboard is fully built — all 5 charts are live.** This section explains why any *future*
chart also has to be made in the browser.

The API does queries and dashboards, and it takes markdown `text_widgets` — but it **cannot
create a visualization**, so it cannot put a chart on a dashboard. Established by probing, not
assumed:

* `visualization_widgets` entries require a `visualization_id`. Send one with only a `query_id`
  and the API 500s; send a valid id and it 200s.
* Nothing creates a visualization: `POST /visualizations`, `POST /visualization`,
  `POST /query/{id}/visualizations`, `POST /dashboards/{id}/widgets` and every neighbouring
  spelling all return 404.

Visualizations are minted by the query editor and belong to a query, so this is a UI step.

⚠️ **`PATCH /dashboards/{id}` replaces the widget lists wholesale.** Sending only
`visualization_widgets` deletes every text widget, and vice versa. Always send both, or you will
silently wipe the half you left out.

### What is on the dashboard

Built via: open `https://dune.com/queries/<id>` → **New** → chart type → **···** →
**Add to dashboard → AbaPay on Base**.

| Query | id | Visualization |
|---|---|---|
| KPI Summary | 8284396 | Table (10 metrics in one row) |
| Daily Volume & Transactions | 8284397 | Bar — `day` × `payments` |
| Volume by Token | 8284398 | Donut — USDC vs USDT |
| DAU / WAU / MAU | 8284434 | Line — all three series |
| New vs Returning Payers | 8284436 | Bar |

The root query (8284395) is the data source and has no chart of its own.

**Retired — off the dashboard and archived on Dune:** `13_by_service` (8284399),
`14_by_contract` (8284400) and `15_by_rail` (8284401). They were judged too internal for the
audience this dashboard is published for — a viewer does not need the V1-vs-V4 migration or
the relayer split. The SQL is kept here so the work is not lost, but the script neither
deploys nor runs them (see `RETIRED` in `scripts/dune-base-setup.mjs`): PATCHing an archived
query would resurrect it, and a query with no panel costs credits to update nothing.

⚠️ Archived is not private. The Community plan caps private queries
(`max_number_of_private_queries_reached`), so these could not be made private — archiving
removes them from the team library and from search, but the `dune.com/queries/<id>` URL still
resolves for anyone who has it. Treat archive as "unlisted", not "hidden", and do not put
anything in a query that would matter if a stranger opened it.

To bring one back: unarchive it on Dune, give it a `DESCRIPTIONS` entry, add its chart to the
dashboard, and remove it from `RETIRED` — all four, or it half-works.

⚠️ **Query descriptions are viewer-facing.** They show under the title on every query page and
on the dashboard. Keep them a plain sentence about what the numbers mean — no repo paths, no
"re-run the script" instructions. Those belong here, in the README, where only maintainers look.

⚠️ **Always check the axes after creating a chart.** Dune auto-picks X and Y, and it picks badly
whenever the query has trailing date or text columns — `Volume by Service` defaulted to
`first_seen` × `last_seen` (a chart of two dates, meaning nothing), and `Agent vs Direct Rail`
put the text column `rail` on Y. Both were corrected by hand under **Chart options → Result
data**. A chart that renders is not the same as a chart that is right.

⚠️ Widget positions are set from `scripts/`-side API calls, not by dragging: Dune drops every new
widget at `row 0, col 0, size_x 3`, which stacks them into one narrow column. The current grid
was applied with a `PATCH /dashboards/{id}` that sends **both** widget lists together.

## Why a second dashboard

The original AbaPay dashboard unions Celo and Base and then splits by chain. That is fine for
volume, but every *user* metric on it — unique payers, DAU/WAU, new vs returning — is computed
across both chains, so the "Base" figures are a slice of a mixed total rather than Base's own
numbers. This dashboard is scoped to Base at the source, so those metrics mean what they say.

## What it tracks

Both AbaPay deployments on Base mainnet, so history survives the redeploy:

| Address | Contract |
|---|---|
| `0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488` | AbaPayV4 — current |
| `0xF3AeFF0c326B1277A2D8623b7694aEB5E6A565e5` | AbaPay V1 — original |

Configured via `ABAPAY_BASE_CONTRACTS` in `.env.local` (`address=label`, comma-separated), not
hardcoded in the SQL — see `scripts/dune-base-setup.mjs`.

## Scope: every on-chain payment, both rails

Money reaches the vault two different ways, and **both are counted**:

| Rail | How it settles | How it is detected |
|---|---|---|
| `Direct (wallet)` | `payBill` on the contract | `PaymentReceived` event |
| `Agent (relayer)` | `payBillFor` — relayer spends a user's allowance | `AgentPayment` in the same tx |
| `x402` | **bare ERC-20 transfer** to the vault, settled by the CDP facilitator | inbound `erc20_base.evt_Transfer` with no `PaymentReceived` in that tx |

⚠️ **x402 emits no `PaymentReceived` at all.** Anything that reads only that event misses it
entirely — which is exactly what happened here at first, and it is not a rounding error. As of
2026-08-12 on Base, x402 is **21 payments worth $352.75 of a $373 total — about 95% of USD
volume**, while the 10,000+ contract-call payments account for under $21. The same holds on
the combined dashboard: **x402 is $20,289 of $26,917 (75%)** across Celo and Base, from 1,019
of 18,531 transactions. Never assume the contract event is the whole picture.

The asymmetry is real, not a bug: contract-call payments are numerous and tiny (airtime and
data top-ups), while x402 settlements are few and large. Counting transactions alone makes
x402 look negligible; counting volume shows it is most of the money.

x402 rows carry `service_type = 'unknown (x402)'` because the item paid for lives in the
off-chain payment requirements, not in any on-chain event. That bucket is honest, not a bug.

⚠️ **`volume_usd` is gross on-chain volume** — what the chain recorded, before anything that
later went back out. It is not a settled or delivered-service figure; the backend database is
what knows whether a payment was fulfilled, refunded or failed. Don't quote it as revenue.

⚠️ **No minimum-amount filter, deliberately.** AbaPay prices in several national currencies
against a USD peg, so genuinely small values occur. Filtering them out to tidy the numbers would
make this dashboard disagree with the chain it exists to mirror.

⚠️ **`service_type` is not normalised.** It is the raw string the contract stored, and the app
has used two naming conventions over time — `mtn` and `MTN Airtime` are the same service, as are
`ibadan-electric` and `IBEDC Electricity`. `13_by_service.sql` therefore reports them as separate
rows. Fixing this needs a deliberate slug→display-name mapping; guessing one in SQL would quietly
merge services that only look related.

## Layout

`00_events.sql` is the **root query** — one row per payment, and the only query that touches
`base.logs`. The other eight read its **materialized view**,
`dune.abapay.result_abapay_base_events`, which is what keeps them cheap.

### ⚠️ The dependents must read the matview, never `query_8284395`

They originally read the root through Dune's `query_<id>` syntax. That syntax **is not a cached
result** — it is a view, and Dune re-executes the entire root query inline for every dependent
that names it. Each of the eight cost **~41 credits** per run instead of **~0.07**: roughly 350
credits a day for one dashboard, against a 2,500/month plan quota. It fails silently — the SQL
is valid and the numbers are correct; only the bill and the rate limiter ever object.

Write `__ROOT_TABLE__` in the SQL and let `scripts/dune-base-setup.mjs` render it. The script
refuses to deploy any file that names a `query_<id>` outside a comment.

The root query also carries a `>= 2026-04-01` floor on **both** of its scans. Without it the
x402 half reads every USDC/USDT transfer on Base since genesis before narrowing to the vault,
which was ~95% of its cost (41.9 → 7.6 credits). AbaPay's first Base payment was 2026-05-01, so
the floor is a month of buffer, not a rolling window that needs maintenance.

| File | Dune id | Query |
|---|---|---|
| `00_events.sql` | 8284395 | Root — decoded payments + agent/direct rail |
| `10_kpi_summary.sql` | 8284396 | All-time KPIs |
| `11_daily_volume.sql` | 8284397 | Daily volume & tx, cumulative line |
| `12_by_token.sql` | 8284398 | USDC vs USDT |
| `13_by_service.sql` | 8284399 | Airtime / data / electricity / TV … |
| `14_by_contract.sql` | 8284400 | V1 vs V4 split — the redeploy migration |
| `15_by_rail.sql` | 8284401 | Agent (relayer) vs direct wallet, daily |
| `16_dau_wau.sql` | 8284434 | DAU / WAU / MAU |
| `17_new_vs_returning.sql` | 8284436 | New vs returning payers, daily |

## Privacy

`PaymentReceived` carries an `accountNumber` — the meter, phone or bill account the customer
paid. It is **deliberately not decoded** into any column here. This dashboard is public; that
field is customer PII and stays in the raw log where it already was.

## Deploying a change

```bash
node scripts/dune-base-setup.mjs --dry-run   # render everything, call nothing
node scripts/dune-base-setup.mjs             # create or update, then verify by running them
```

The script is idempotent — ids recorded in `src/lib/dune/base-query-ids.json` are updated in
place, anything missing is created. Edit the SQL **here**, never in the Dune web editor: a
web-editor change makes this directory silently wrong with no way to diff it.

Creating queries over the Dune API needs a paid plan. On the Community plan the script detects
the 402/403, prints the rendered SQL for each file (`--print 00`) to paste into dune.com by
hand, and asks you to record the resulting ids in `src/lib/dune/base-query-ids.json`. After
that first manual pass it can update them over the API normally.

## Refresh

Two mechanisms, and **both are required**. Confusing them is what left this dashboard
refreshing nothing for a day while CI showed a green tick.

| Layer | What keeps it fresh | When |
|---|---|---|
| **Data** — `dune.abapay.result_abapay_base_events` | Dune's own matview cron | 02:00 UTC daily |
| **Panels** — the 8 dependent queries | `/api/cron/dune-refresh?dashboard=base`, from `.github/workflows/dune-refresh.yml` | 03:15 UTC daily |

A dashboard panel renders the **last execution** of the query behind it. Refreshing a matview
does *not* count as an execution of that query, so the matview cron alone will never move a
panel — the combined dashboard sat six days stale while its matviews refreshed every six hours.
Equally, executing the queries alone would just re-aggregate a stale table.

Dune's built-in **query** scheduler cannot help: it requires the medium/large engines, which the
Community plan does not have. Matview crons are the one piece of Dune-native scheduling that
does work on this plan, which is why the data layer uses them.

The root query (8284395) is deliberately **not** executed by the cron. It has no panel on the
dashboard, so executing it would cost ~7.6 credits to update nothing; its matview cron is what
re-runs it.
