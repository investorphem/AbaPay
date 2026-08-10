import 'server-only';
import { NextResponse } from 'next/server';

// ⚡ DUNE DASHBOARD REFRESH — re-runs the AbaPay analytics queries so the public dashboard
// stops going stale.
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
// /api/schedules/run; point any external cron (cron-job.org, GitHub Actions, Vercel cron) at it.

export const maxDuration = 300;

const DUNE_API = 'https://api.dune.com/api/v1';

// The base query materialises one row per settled payment; every other query reads from it,
// so it must finish BEFORE the dependents run or they aggregate yesterday's rows.
const BASE_QUERY = 8178700; // AbaPay - Unified Payments (base)

const DEPENDENT_QUERIES = [
  8178726, // KPI Summary (all-time)
  8178727, // Volume & Tx by Rail
  8178728, // Volume & Tx by Chain
  8178729, // Volume & Tx by Token (chain-scoped)
  8178732, // DAU and WAU
  8178734, // New vs Returning Users (daily)
];

// `small` is deliberate, not a cost saving: the free engine has a 2-minute ceiling that the
// base query already exceeded once as the chain log tables grew (see the comment in the query
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

  // ⚡ STAGES — because the two halves have very different time profiles and hosting plans cap
  // function duration (Vercel Hobby 60s, Pro 300s; cron-job.org's free tier disconnects at 30s).
  //
  //   ?stage=base        start the base query, return immediately   (fast)
  //   ?stage=dependents  start the six aggregates, return           (fast)
  //   (no stage)         base -> wait -> dependents in one call     (slow, needs ~4 min)
  //
  // Two short crons 15 minutes apart is the robust setup and works on any plan. The combined
  // mode is kept for manual runs and for hosts that allow a long invocation.
  const stage = new URL(req.url).searchParams.get('stage');

  if (stage === 'dependents') {
    const dependents: Record<number, string | null> = {};
    for (const id of DEPENDENT_QUERIES) dependents[id] = await execute(apiKey, id);
    const n = Object.values(dependents).filter(Boolean).length;
    return NextResponse.json({ ok: n === DEPENDENT_QUERIES.length, stage, dependents, startedDependents: `${n}/${DEPENDENT_QUERIES.length}` });
  }

  const baseExec = await execute(apiKey, BASE_QUERY);
  if (!baseExec) {
    return NextResponse.json({ error: 'Base query failed to start.', base: BASE_QUERY }, { status: 502 });
  }

  if (stage === 'base') {
    // Deliberately no wait: the dependents run from their own cron 15 minutes later, by which
    // time this has long since finished. Keeps the invocation well inside any plan's ceiling.
    return NextResponse.json({ ok: true, stage, base: { queryId: BASE_QUERY, executionId: baseExec } });
  }

  // Combined mode. Give the base most of the budget. If it overruns we still refresh the
  // dependents — a dashboard one run behind beats a dashboard six days behind — but we say so in
  // the response so a stale-looking dashboard is explainable rather than mysterious.
  const baseState = await waitFor(apiKey, baseExec, 210_000);
  const baseCompleted = baseState === 'QUERY_STATE_COMPLETED';

  const dependents: Record<number, string | null> = {};
  for (const id of DEPENDENT_QUERIES) {
    dependents[id] = await execute(apiKey, id);
  }

  const started = Object.values(dependents).filter(Boolean).length;
  return NextResponse.json({
    ok: baseCompleted && started === DEPENDENT_QUERIES.length,
    base: { queryId: BASE_QUERY, executionId: baseExec, state: baseState },
    dependents,
    startedDependents: `${started}/${DEPENDENT_QUERIES.length}`,
    note: baseCompleted
      ? undefined
      : `Base query did not complete within the budget (state: ${baseState}); dependents may aggregate the previous run's rows.`,
  });
}

export const GET = handle;
export const POST = handle;
