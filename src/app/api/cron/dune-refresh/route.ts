import 'server-only';
import { NextResponse } from 'next/server';
import baseChainQueryIds from '@/lib/dune/base-query-ids.json';
import { verifyCronRequest } from '@/utils/cronAuth';

// ⚡ DUNE DASHBOARD REFRESH — re-runs the AbaPay analytics queries so the public dashboards
// stop going stale.
//
// ─── HOW THE TWO HALVES OF A DASHBOARD STAY FRESH ──────────────────────────────
//
// These are NOT the same mechanism, and conflating them is what broke this route once
// already:
//
//   1. The DATA behind a dashboard lives in a materialized view (one per root query,
//      `dune.abapay.result_abapay_*`). Dune refreshes those on its own cron — set at
//      creation time, 02:00 UTC daily. Nothing in this repo needs to trigger them, and
//      this route deliberately does not.
//
//   2. A dashboard PANEL renders the *last execution result* of the query behind it.
//      Refreshing a materialized view does NOT count as an execution of that query —
//      verified: the root query's `latest_execution_id` stays pinned to the last API
//      execution while its matview races ahead. So panels only move when something
//      calls /execute on the query itself. That something is this route.
//
// 🔴 THAT DISTINCTION IS THE WHOLE BUG HISTORY. The combined dashboard sat six days
// stale (newest row 2026-08-04) *while its matviews were refreshing every six hours*,
// because nobody was executing the queries. Adding matviews does not remove the need
// for this route; removing this route does not get compensated for by the matviews.
//
// ─── WHY NOT DUNE'S OWN QUERY SCHEDULER ────────────────────────────────────────
//
// Dune's built-in *query* scheduler only runs on the medium and large engines
// (docs.dune.com/web-app/query-editor/query-scheduler), and this account's plan
// (community_fluid_engine_v2) cannot use them — asking for `medium` returns
// "Performance medium is not supported for this dataset". Matview crons are the one
// piece of Dune-native scheduling that *does* work on this plan, which is why the data
// layer uses them and the panel layer uses this route.
//
// ─── WHAT THIS ROUTE COSTS ─────────────────────────────────────────────────────
//
// Every query it executes reads a matview, never the raw chain tables: ~0.07 credits
// each, well under 1 credit for all ten. It used to execute the root queries too, which cost
// ~41 credits a run and updated no panel at all, because neither root has a widget on
// either dashboard. Do not add them back. If a root needs re-running, refresh its
// matview — that is what the matview cron is for.
//
// ⚠️ NAMING: "root query" means the query whose matview every other query in the same
// dashboard reads. It has nothing to do with the Base *chain* — one of the two
// dashboards happens to be Base-only, which makes "base query" hopelessly ambiguous.

export const maxDuration = 300;

const DUNE_API = 'https://api.dune.com/api/v1';

type Dashboard = {
  label: string;
  /** The matview these all read. Refreshed by Dune's cron, never by this route. */
  sourceTable: string;
  /** The queries with panels on the dashboard. These are what actually get executed. */
  panelQueries: number[];
};

// ─── The combined Celo + Base dashboard (the original one) ──────────────────────
const MAIN_DASHBOARD: Dashboard = {
  label: 'AbaPay — Unified Payments (Celo + Base)',
  sourceTable: 'dune.abapay.result_abapay_unified_payments',
  // ⚠️ Exactly the queries WITH A PANEL on the dashboard, which is not the same as every
  // query that exists. 8178727 (Volume & Tx by Rail) is still deployed and still works,
  // but it was taken off the dashboard, so executing it would spend credits updating
  // something nobody can see. Add a query here only when it has a widget.
  panelQueries: [
    8178726, // KPI Summary (all-time) — 4 counters + the summary table
    8178728, // Volume & Tx by Chain
    8178729, // Volume & Tx by Token (chain-scoped)
    8178732, // DAU and WAU
    8178734, // New vs Returning Users (daily)
  ],
};

// ─── The Base-only dashboard ────────────────────────────────────────────────────
//
// Query ids are generated, not hand-written here: `scripts/dune-base-setup.mjs` deploys the
// SQL in `dune/base-chain/` and records what Dune assigned. Until that has been run, the ids
// are null and this route says so explicitly rather than reporting a successful refresh of
// nothing — a cron that reports OK while refreshing zero queries is how a dashboard goes
// stale unnoticed, which is the exact failure this whole route exists to prevent.
const BASE_CHAIN_DASHBOARD: Dashboard | null =
  typeof baseChainQueryIds.rootQueryId === 'number'
    ? {
        label: 'AbaPay on Base (Base mainnet only)',
        sourceTable: 'dune.abapay.result_abapay_base_events',
        panelQueries: baseChainQueryIds.dependentQueryIds as number[],
      }
    : null;

const DASHBOARDS: Record<string, Dashboard | null> = {
  main: MAIN_DASHBOARD,
  base: BASE_CHAIN_DASHBOARD,
};

// `small` is not a cost saving, it is the only engine this plan has: medium/large return
// "Performance medium is not supported for this dataset". Every query here reads a matview,
// so `small` is ample — none of them go near the engine's 2-minute ceiling.
const PERFORMANCE = 'small';

/**
 * Gap between consecutive /execute calls.
 *
 * 🔴 NOT POLITENESS — THIS IS THE FIX FOR A REAL OUTAGE. The first scheduled run fired
 * fourteen /execute calls in about three seconds. Dune refused most of them: four of the
 * six combined-dashboard queries started, and none of the eight Base ones did. The route
 * reported HTTP 200 anyway (see the status code note below), so the workflow went green
 * while the entire Base dashboard refreshed nothing.
 */
const SPACING_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Started = {
  queryId: number;
  executionId: string | null;
  /** Did the execution reach QUERY_STATE_COMPLETED? A started query is not a fresh panel. */
  completed?: boolean;
  error?: string;
};

/**
 * Statuses worth another attempt.
 *
 * 🔴 THIS USED TO BE `=== 429` AND NOTHING ELSE, which is what left the Base dashboard
 * half-refreshed. On 2026-08-15 the refresh step ran 03:51:07 → 03:52:08: `main` spent ~54s
 * on a 7.5s workload (the full retry ladder, i.e. 429s) and recovered, while `base` fired all
 * five queries in 7s flat with no retries at all and still lost two of them. A fast non-429
 * response — a 5xx from Dune, a dropped upstream, a concurrent-execution rejection — was
 * returned immediately as a permanent loss, so the two unlucky queries were never retried and
 * their panels simply stayed a day stale.
 *
 * Only a genuine 4xx about THIS request (a deleted query, a malformed body, a bad key) is
 * hopeless on a retry; those still fail fast so a real misconfiguration stays loud.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || status >= 500;
}

/**
 * Start one query, backing off through Dune's rate limiter.
 *
 * The ladder is longer and wider than before because the old one demonstrably was not enough:
 * two `main` queries needed the whole of it on the run above and only just made it.
 */
async function execute(apiKey: string, queryId: number): Promise<Started> {
  const backoffs = [2000, 5000, 12_000, 25_000];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
        method: 'POST',
        headers: { 'X-DUNE-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ performance: PERFORMANCE }),
      });
    } catch (err) {
      // A dropped connection is worth one more go for the same reason a 429 is.
      if (attempt < backoffs.length) {
        await sleep(backoffs[attempt]);
        continue;
      }
      return { queryId, executionId: null, error: `fetch failed: ${(err as Error)?.message}` };
    }

    if (isRetryableStatus(res.status) && attempt < backoffs.length) {
      // Log every retry — a run that only just scraped through looks identical to a healthy
      // one otherwise, which is how this degraded unnoticed until it started failing outright.
      console.warn(`[dune-refresh] execute ${queryId} got ${res.status}, retry ${attempt + 1}/${backoffs.length}`);
      await sleep(backoffs[attempt]);
      continue;
    }

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[dune-refresh] execute ${queryId} failed:`, res.status, body);
      return { queryId, executionId: null, error: `HTTP ${res.status}: ${body}` };
    }

    const json = await res.json();
    const executionId = json?.execution_id ?? null;
    return executionId
      ? { queryId, executionId }
      : { queryId, executionId: null, error: 'Dune accepted the request but returned no execution_id' };
  }
}

// How long to wait for one execution to reach a terminal state before giving up on it.
//
// ⚠️ SIZED AGAINST `maxDuration = 300`. Both the initial pass and the retry pass poll in
// parallel, so the route's worst case is roughly: start (5 x 1.5s) + poll (60s) + retry start
// (5 x 1.5s) + poll (60s) ≈ 135s. That leaves real headroom under 300s. Raising this much
// further, or polling sequentially, would let a bad day hit the platform timeout — which
// reports a failure for queries that were actually running fine.
//
// Every query here reads a matview and returns in a few seconds; 60s is already generous.
const EXECUTION_POLL_TIMEOUT_MS = 60_000;
const EXECUTION_POLL_INTERVAL_MS = 3000;

/**
 * Wait for a started execution to actually FINISH, and say whether it succeeded.
 *
 * 🔴 THE HOLE THIS CLOSES. /execute returning an execution_id means Dune accepted the job,
 * NOT that the query ran — an accepted execution can still end QUERY_STATE_FAILED, and when it
 * does the panel keeps rendering yesterday's result while this route reports a clean 200. That
 * is the same "green tick over a stale dashboard" failure the status-code comment below was
 * written for, one level deeper: we fixed reporting on queries that never started, and went on
 * trusting queries that started and then died.
 *
 * It is also the only way to distinguish the two on the Base dashboard, whose queries were
 * being reported as started while their panels did not move.
 */
async function waitForCompletion(apiKey: string, s: Started): Promise<Started> {
  if (!s.executionId) return { ...s, completed: false };

  const deadline = Date.now() + EXECUTION_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DUNE_API}/execution/${s.executionId}/status`, {
        headers: { 'X-DUNE-API-KEY': apiKey },
      });
      if (res.ok) {
        const state = (await res.json())?.state as string | undefined;
        if (state === 'QUERY_STATE_COMPLETED') return { ...s, completed: true };
        if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED' || state === 'QUERY_STATE_EXPIRED') {
          console.error(`[dune-refresh] query ${s.queryId} execution ${s.executionId} ended ${state}`);
          return { ...s, completed: false, error: `execution ended ${state}` };
        }
      }
    } catch {
      // A failed status poll says nothing about the execution — keep waiting.
    }
    await sleep(EXECUTION_POLL_INTERVAL_MS);
  }

  // Still running at the deadline. Deliberately NOT counted as a failure: the execution is
  // very likely to land on its own, and re-running it would spend credits to no purpose.
  // Reported so a persistently slow query is visible rather than silent.
  return { ...s, completed: true, error: 'still running when the refresh finished (not re-run)' };
}

async function handle(req: Request) {
  // 🔐 Fail-closed — see src/utils/cronAuth.ts. Unauthenticated this burns paid Dune API
  // credits on demand for anyone who finds the URL.
  const unauthorized = verifyCronRequest(req);
  if (unauthorized) return unauthorized;

  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'DUNE_API_KEY is not set.' }, { status: 500 });
  }

  const params = new URL(req.url).searchParams;

  // ?dashboard=main (default, back-compatible with the pre-existing crons) | base
  const dashboardKey = params.get('dashboard') || 'main';
  if (!(dashboardKey in DASHBOARDS)) {
    return NextResponse.json(
      { error: `Unknown dashboard "${dashboardKey}".`, known: Object.keys(DASHBOARDS) },
      { status: 400 },
    );
  }
  const dashboard = DASHBOARDS[dashboardKey];
  if (!dashboard) {
    return NextResponse.json(
      {
        error: `The "${dashboardKey}" dashboard has no Dune query ids yet.`,
        fix: 'Run `node scripts/dune-base-setup.mjs` to deploy dune/base-chain/*.sql, then commit src/lib/dune/base-query-ids.json.',
      },
      { status: 503 },
    );
  }

  // ⚠️ `?stage=` is accepted and ignored. It used to split this route into "start the root
  // query" and "start the dependents", with a wait in between, because the dependents read
  // the root's freshly-written rows. They no longer do — they read a matview on its own
  // cron — so there is nothing to sequence and nothing to wait for. Old crons that still
  // pass ?stage=root or ?stage=dependents get the same full refresh either way; a stage
  // that silently did nothing would be a worse answer than doing the work twice.
  const legacyStage = params.get('stage');

  // Phase 1 — start every panel query, spaced so the burst doesn't trip the rate limiter.
  let started: Started[] = [];
  for (const [i, queryId] of dashboard.panelQueries.entries()) {
    if (i > 0) await sleep(SPACING_MS);
    started.push(await execute(apiKey, queryId));
  }

  // Phase 2 — wait for them to actually finish. Polled in PARALLEL: they were started
  // seconds apart and run concurrently on Dune, so waiting on them one at a time would add
  // their runtimes together for no benefit.
  started = await Promise.all(started.map((s) => waitForCompletion(apiKey, s)));

  // Phase 3 — one retry pass over whatever genuinely did not refresh, whether it failed to
  // start or started and then died. By now the initial burst is well past, so the limiter has
  // had time to drain and a retry has a real chance — which is exactly what the two lost Base
  // queries never got. Bounded to a single pass so a genuinely broken query cannot turn the
  // cron into a credit-burning retry loop.
  //
  // Structured start-all-then-poll-all, exactly like phase 1, rather than
  // start-and-wait per query: sequential waiting would ADD the poll timeouts together
  // (5 x 60s) and blow the route's 300s maxDuration, killing the run mid-retry and
  // reporting a failure for work that was actually in flight.
  const needsRetry = started.filter((s) => !s.completed);
  if (needsRetry.length > 0) {
    console.warn(`[dune-refresh] ${dashboardKey}: retrying ${needsRetry.map((s) => s.queryId).join(', ')}`);
    const retried: Started[] = [];
    for (const [i, s] of needsRetry.entries()) {
      if (i > 0) await sleep(SPACING_MS);
      retried.push(await execute(apiKey, s.queryId));
    }
    const settled = await Promise.all(retried.map((s) => waitForCompletion(apiKey, s)));
    started = started.map((original) => settled.find((r) => r.queryId === original.queryId) ?? original);
  }

  // ⚠️ `ok` now means "the panel is genuinely fresh", not merely "Dune accepted the request".
  // Those are different claims, and reporting the second while implying the first is what let
  // the Base dashboard go stale under a green tick.
  const ok = started.every((s) => s.completed);
  const okCount = started.filter((s) => s.completed).length;

  // 🔴 THE STATUS CODE MUST TRACK `ok`. This used to return 200 unconditionally, with the
  // real outcome buried in an `ok: false` field that the workflow never read — so a run
  // that started zero of eight queries was indistinguishable from a clean one, and the
  // Base dashboard silently stopped refreshing the day it was wired up. Any caller that
  // only checks the HTTP status must still be able to notice this failing.
  return NextResponse.json(
    {
      ok,
      dashboard: dashboardKey,
      label: dashboard.label,
      sourceTable: dashboard.sourceTable,
      started: `${okCount}/${dashboard.panelQueries.length}`,
      queries: started,
      ...(legacyStage ? { note: `Ignored legacy ?stage=${legacyStage}; this route no longer has stages.` } : {}),
    },
    { status: ok ? 200 : 502 },
  );
}

export const GET = handle;
export const POST = handle;
