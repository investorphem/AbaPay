import 'server-only';
import { NextResponse } from 'next/server';
import baseChainQueryIds from '@/lib/dune/base-query-ids.json';

// ⚡ DUNE DASHBOARD REFRESH — re-runs the AbaPay analytics queries so the public dashboards
// stop going stale.
//
// 🔴 WHY THIS EXISTS RATHER THAN DUNE'S OWN SCHEDULER: Dune's built-in query scheduler only
// runs on the **medium and large** engines (docs.dune.com/web-app/query-editor/query-scheduler),
// and this account's plan (community_fluid_engine_v2) cannot use them — asking for `medium`
// returns "Performance medium is not supported for this dataset". So the in-app schedule can
// never fire no matter how it is configured, which is exactly what we saw: the dashboard sat
// six days stale (newest row 2026-08-04) until someone pressed Run by hand.
//
// The API path has no such restriction — `small` executes fine — so a plain cron hitting this
// route does what the scheduler cannot. Same CRON_SECRET convention as /api/cleanup and
// /api/schedules/run. `.github/workflows/dune-refresh.yml` drives it daily; any external cron
// (cron-job.org, Vercel cron) works just as well.
//
// ⚠️ NAMING: "root query" below means the query that materialises the rows every other query
// in the same dashboard reads. It has nothing to do with the Base *chain* — one of the two
// dashboards happens to be Base-only, which makes "base query" hopelessly ambiguous here.

export const maxDuration = 300;

const DUNE_API = 'https://api.dune.com/api/v1';

type Dashboard = {
  label: string;
  /** Materialises the rows the dependents read; must finish BEFORE they run. */
  rootQuery: number;
  dependents: number[];
};

// ─── The combined Celo + Base dashboard (the original one) ──────────────────────
const MAIN_DASHBOARD: Dashboard = {
  label: 'AbaPay — Unified Payments (Celo + Base)',
  rootQuery: 8178700, // AbaPay - Unified Payments (base table)
  dependents: [
    8178726, // KPI Summary (all-time)
    8178727, // Volume & Tx by Rail
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
        rootQuery: baseChainQueryIds.rootQueryId,
        dependents: baseChainQueryIds.dependentQueryIds as number[],
      }
    : null;

const DASHBOARDS: Record<string, Dashboard | null> = {
  main: MAIN_DASHBOARD,
  base: BASE_CHAIN_DASHBOARD,
};

// `small` is deliberate, not a cost saving: the free engine has a 2-minute ceiling that the
// root query already exceeded once as the chain log tables grew (see the comment in the query
// itself), and medium/large are unavailable on this plan.
const PERFORMANCE = 'small';

async function execute(apiKey: string, queryId: number): Promise<string | null> {
  const res = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
    method: 'POST',
    headers: { 'X-DUNE-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ performance: PERFORMANCE }),
  });
  if (!res.ok) {
    console.error(`[dune-refresh] execute ${queryId} failed:`, res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const json = await res.json();
  return json?.execution_id ?? null;
}

/** Poll an execution until it leaves the pending/executing states, or we run out of budget. */
async function waitFor(apiKey: string, executionId: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${DUNE_API}/execution/${executionId}/status`, {
      headers: { 'X-DUNE-API-KEY': apiKey },
    });
    if (!res.ok) return 'STATUS_ERROR';
    const state = (await res.json())?.state ?? 'UNKNOWN';
    if (state !== 'QUERY_STATE_PENDING' && state !== 'QUERY_STATE_EXECUTING') return state;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return 'TIMEOUT';
}

async function handle(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization') || '';
    const headerSecret = req.headers.get('x-cron-secret') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : headerSecret;
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

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

  // ⚡ STAGES — because the two halves have very different time profiles and hosting plans cap
  // function duration (Vercel Hobby 60s, Pro 300s; cron-job.org's free tier disconnects at 30s).
  //
  //   ?stage=root        start the root query, return immediately   (fast)
  //   ?stage=dependents  start the aggregates, return               (fast)
  //   (no stage)         root -> wait -> dependents in one call     (slow, needs ~4 min)
  //
  // Two short crons 15 minutes apart is the robust setup and works on any plan. The combined
  // mode is kept for manual runs and for hosts that allow a long invocation.
  //
  // `stage=base` is the old spelling of `stage=root`, still accepted so the crons registered
  // before the Base-only dashboard existed keep working. Do not reuse that word for the Base
  // chain — see the naming note at the top.
  const stageParam = params.get('stage');
  const stage = stageParam === 'base' ? 'root' : stageParam;

  const { rootQuery, dependents: dependentQueries } = dashboard;

  if (stage === 'dependents') {
    const dependents: Record<number, string | null> = {};
    for (const id of dependentQueries) dependents[id] = await execute(apiKey, id);
    const n = Object.values(dependents).filter(Boolean).length;
    return NextResponse.json({
      ok: n === dependentQueries.length,
      dashboard: dashboardKey,
      stage: 'dependents',
      dependents,
      startedDependents: `${n}/${dependentQueries.length}`,
    });
  }

  const rootExec = await execute(apiKey, rootQuery);
  if (!rootExec) {
    return NextResponse.json(
      { error: 'Root query failed to start.', dashboard: dashboardKey, rootQuery },
      { status: 502 },
    );
  }

  if (stage === 'root') {
    // Deliberately no wait: the dependents run from their own cron 15 minutes later, by which
    // time this has long since finished. Keeps the invocation well inside any plan's ceiling.
    return NextResponse.json({
      ok: true,
      dashboard: dashboardKey,
      stage: 'root',
      root: { queryId: rootQuery, executionId: rootExec },
    });
  }

  // Combined mode. Give the root query most of the budget. If it overruns we still refresh the
  // dependents — a dashboard one run behind beats a dashboard six days behind — but we say so in
  // the response so a stale-looking dashboard is explainable rather than mysterious.
  const rootState = await waitFor(apiKey, rootExec, 210_000);
  const rootCompleted = rootState === 'QUERY_STATE_COMPLETED';

  const dependents: Record<number, string | null> = {};
  for (const id of dependentQueries) {
    dependents[id] = await execute(apiKey, id);
  }

  const started = Object.values(dependents).filter(Boolean).length;
  return NextResponse.json({
    ok: rootCompleted && started === dependentQueries.length,
    dashboard: dashboardKey,
    root: { queryId: rootQuery, executionId: rootExec, state: rootState },
    dependents,
    startedDependents: `${started}/${dependentQueries.length}`,
    note: rootCompleted
      ? undefined
      : `Root query did not complete within the budget (state: ${rootState}); dependents may aggregate the previous run's rows.`,
  });
}

export const GET = handle;
export const POST = handle;
