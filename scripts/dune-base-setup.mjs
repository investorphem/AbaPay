#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deploy the Base-only AbaPay dashboard's queries to Dune.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   node scripts/dune-base-setup.mjs            create (or update) all 9 queries
 *   node scripts/dune-base-setup.mjs --dry-run  print the rendered SQL, call nothing
 *   node scripts/dune-base-setup.mjs --print 00 print one rendered file, to paste by hand
 *   node scripts/dune-base-setup.mjs --verify   deploy nothing, just run them and report
 *
 * WHY A SCRIPT AND NOT THE DUNE UI: the SQL under `dune/base-chain/` is the source of
 * truth. Editing a query in the web editor makes the repo silently wrong, and there is
 * no way to diff or review it. Run this instead — it is idempotent: query IDs recorded
 * in `src/lib/dune/base-query-ids.json` are PATCHed, anything missing is created.
 *
 * ⚠️ The dependent queries read the root query's MATERIALIZED VIEW by name, not through
 * Dune's `query_<id>` syntax. That distinction is load-bearing — see ROOT_TABLE below.
 * The matview is created once, out of band; this script only deploys SQL.
 *
 * ⚠️ Creating queries over the API is a PAID Dune feature. On the Community plan the
 * create call comes back 402/403 — the script detects that and falls back to printing
 * the rendered SQL for you to paste into dune.com by hand, then asks for the IDs to be
 * written into query-ids.json. Nothing is lost either way; the SQL is identical.
 *
 * The API key must belong to the **abapay team** (Dune → team settings → API keys),
 * otherwise the queries land in your personal account instead of the team.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SQL_DIR = join(REPO, 'dune', 'base-chain');
// Lives under src/ rather than next to the SQL because the cron route imports it —
// a JSON import that reaches outside src/ is exactly the kind of path that breaks a
// production build without breaking `next dev`.
const IDS_FILE = join(REPO, 'src', 'lib', 'dune', 'base-query-ids.json');

const DUNE_API = 'https://api.dune.com/api/v1';

/**
 * The materialized view of the root query, which all eight dependents read.
 *
 * 🔴 IT MUST BE THIS AND NOT `query_<root id>`. Dune's `query_<id>` syntax looks like it
 * reads the root query's cached result; it does not. It is a view, and Dune re-executes
 * the entire root query inline for every dependent that names it. The dependents were
 * originally written that way and each one cost ~41 credits per run instead of ~0.07 —
 * about 350 credits a day for one dashboard, against a 2,500/month plan quota.
 *
 * Creating the matview is a one-time step and is NOT done by this script (query CRUD over
 * the API is a paid feature on some plans and matview creation is a separate endpoint
 * again). If it does not exist yet, create it once against the deployed root query with
 * the name below, engine `small`, cron `0 2 * * *`, then run this script. Dune refreshes
 * it on that cron from then on — it is the only Dune-native scheduling the Community plan
 * can actually use.
 */
const ROOT_TABLE = 'dune.abapay.result_abapay_base_events';

/** `--verify`: skip deployment, just run the already-deployed queries and report. */
let VERIFY_ONLY = false;

// Loaded lazily so `--print`/`--dry-run` work in a checkout with no .env.local.
async function loadEnv() {
  const dotenv = await import('dotenv');
  for (const f of ['.env.local', '.env']) {
    const p = join(REPO, f);
    if (existsSync(p)) dotenv.config({ path: p, override: false });
  }
}

// ─── Contract configuration ────────────────────────────────────────────────────
//
// Deliberately NOT inferred from NEXT_PUBLIC_ABAPAY_BASE_ADDRESS alone: that variable
// only ever holds the *current* deployment, and the whole point of this dashboard is
// that the earlier Base contract's history stays attached. Silently guessing the
// second address would mean publishing a dashboard that tracks the wrong contract, so
// this is required and validated instead.
//
//   ABAPAY_BASE_CONTRACTS="0xC0A4…=AbaPayV4 (current),0xF3AeFF…=AbaPay V1 (original)"
//
// Order matters only for readability; labels are what appear on the dashboard.
function readContracts() {
  const raw = process.env.ABAPAY_BASE_CONTRACTS;
  if (!raw || !raw.trim()) {
    fail(
      'ABAPAY_BASE_CONTRACTS is not set.\n\n' +
        'Set it to the AbaPay contract addresses on Base, comma-separated,\n' +
        'each optionally labelled with "=":\n\n' +
        '  ABAPAY_BASE_CONTRACTS="0xNEW=AbaPayV4 (current),0xOLD=AbaPay V1 (original)"\n'
    );
  }

  const contracts = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      const address = (eq === -1 ? entry : entry.slice(0, eq)).trim().toLowerCase();
      const label = eq === -1 ? address : entry.slice(eq + 1).trim();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        fail(`"${address}" in ABAPAY_BASE_CONTRACTS is not a 20-byte 0x address.`);
      }
      return { address, label };
    });

  if (contracts.length === 0) fail('ABAPAY_BASE_CONTRACTS parsed to zero addresses.');

  const seen = new Set();
  for (const c of contracts) {
    if (seen.has(c.address)) fail(`${c.address} appears twice in ABAPAY_BASE_CONTRACTS.`);
    seen.add(c.address);
  }
  return contracts;
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

/** All 9 queries, in dependency order. `00_events` must be first — the rest read it. */
function sqlFiles() {
  return readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

const TITLES = {
  '00_events.sql': 'AbaPay (Base) — Events',
  '10_kpi_summary.sql': 'AbaPay (Base) — KPI Summary',
  '11_daily_volume.sql': 'AbaPay (Base) — Daily Volume & Transactions',
  '12_by_token.sql': 'AbaPay (Base) — Volume by Token',
  '13_by_service.sql': 'AbaPay (Base) — Volume by Service',
  '14_by_contract.sql': 'AbaPay (Base) — Volume by Contract',
  '15_by_rail.sql': 'AbaPay (Base) — Agent vs Direct Rail',
  '16_dau_wau.sql': 'AbaPay (Base) — DAU / WAU / MAU',
  '17_new_vs_returning.sql': 'AbaPay (Base) — New vs Returning Payers',
};

function render(file, contracts) {
  let sql = readFileSync(join(SQL_DIR, file), 'utf8');

  sql = sql.replaceAll('__CONTRACT_LIST__', contracts.map((c) => c.address).join(', '));

  // ⚠️ No table alias on `contract_address`. An earlier version emitted `CASE e.contract_address`,
  // which silently hardcoded the alias the SQL happened to use at the time — renaming it in the
  // .sql file produced a query that deployed cleanly and only failed later, at execution, with
  // "Column 'e.contract_address' cannot be resolved". Bare and unambiguous is the safe form.
  sql = sql.replaceAll(
    '__CONTRACT_LABEL_CASE__',
    [
      'CASE contract_address',
      ...contracts.map((c) => `        WHEN ${c.address} THEN '${c.label.replaceAll("'", "''")}'`),
      "        ELSE 'unknown'",
      '    END',
    ].join('\n')
  );

  sql = sql.replaceAll('__ROOT_TABLE__', ROOT_TABLE);

  const leftover = sql.match(/__[A-Z_]+__/);
  if (leftover) fail(`${file} still contains the placeholder ${leftover[0]} after rendering.`);

  // 🔴 REGRESSION GUARD. `query_<id>` re-executes the root query inline for every
  // dependent that names it — the mistake this dashboard shipped with, worth ~350
  // credits a day. It is a silent one: the SQL is valid, the numbers are right, and
  // only the bill and the rate limiter ever complain. Refuse to deploy it.
  //
  // Comments are stripped first: 00_events.sql documents this very trap by name, and
  // matching inside comments would make the file that explains the rule fail the rule.
  const queryRef = sql.replace(/--[^\n]*/g, '').match(/\bquery_\d+\b/);
  if (queryRef) {
    fail(
      `${file} reads the root query as \`${queryRef[0]}\`.\n\n` +
        `  That is a view, not a cached result — Dune re-runs the whole root query inline\n` +
        `  every time this one executes (~41 credits instead of ~0.07). Read the\n` +
        `  materialized view instead: write __ROOT_TABLE__, which renders to\n` +
        `  ${ROOT_TABLE}.`
    );
  }

  return sql;
}

// ─── Dune API ──────────────────────────────────────────────────────────────────

/**
 * One Dune API call, retrying transport-level failures.
 *
 * 🔴 `fetch` throws a bare "TypeError: fetch failed" on a dropped connection or DNS blip,
 * which is indistinguishable in a stack trace from a bug and killed two otherwise-fine
 * deploys mid-run. A network hiccup should not abort a nine-query deployment — especially
 * one that is partway through creating queries. HTTP-level failures (4xx/5xx) are returned
 * to the caller untouched: those are answers, and the caller knows which ones to retry.
 */
async function duneFetch(apiKey, path, init) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(`${DUNE_API}${path}`, {
        ...init,
        headers: { 'X-DUNE-API-KEY': apiKey, 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
    } catch (err) {
      lastError = err;
      const wait = 3000 * (attempt + 1);
      console.log(`    network error (${err?.message ?? err}), retrying in ${wait / 1000}s…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

async function dune(apiKey, path, init = {}) {
  const res = await duneFetch(apiKey, path, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Run a write call, backing off through Dune's rate limit.
 *
 * 🔴 The Community plan throttles query writes — CREATE *and* PATCH alike — hard enough
 * that touching nine queries in a row trips a 429 partway. Retrying is not optional
 * politeness here: a run that dies partway leaves half a dashboard on Dune, and on the
 * very first run the naive recovery (just run it again) would create SECOND copies of
 * everything that had already worked.
 */
async function withRateLimitRetry(label, send) {
  const backoffs = [10_000, 30_000, 60_000, 90_000];
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    if (res.status !== 429 || attempt >= backoffs.length) return res;
    const wait = backoffs[attempt];
    console.log(`    ${label}: rate-limited (429), retrying in ${wait / 1000}s…`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function createQuery(apiKey, name, sql, description) {
  return withRateLimitRetry(name, () =>
    dune(apiKey, '/query', {
      method: 'POST',
      body: JSON.stringify({ name, query_sql: sql, description, is_private: false }),
    })
  );
}

async function updateQuery(apiKey, id, name, sql, description) {
  return withRateLimitRetry(name, () =>
    dune(apiKey, `/query/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, query_sql: sql, description }),
    })
  );
}

/** Run a query on the `small` engine — the only one this plan has — and wait for it. */
async function executeAndWait(apiKey, id, budgetMs = 240_000) {
  // Executions are rate-limited on this plan too, so the same backoff applies — otherwise
  // verification reports a healthy query as broken purely because it asked too soon.
  const started = await withRateLimitRetry(`execute ${id}`, () =>
    dune(apiKey, `/query/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ performance: 'small' }),
    })
  );
  if (!started.ok) return { state: 'START_FAILED', detail: started.text.slice(0, 300) };

  const executionId = started.json.execution_id;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const status = await dune(apiKey, `/execution/${executionId}/status`);
    if (!status.ok) return { state: 'STATUS_ERROR', executionId };
    const state = status.json.state;
    if (state !== 'QUERY_STATE_PENDING' && state !== 'QUERY_STATE_EXECUTING') {
      return { state, executionId };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { state: 'TIMEOUT', executionId };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function readIds() {
  if (!existsSync(IDS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(IDS_FILE, 'utf8')).queries ?? {};
  } catch {
    return {};
  }
}

function writeIds(queries, { quiet = false } = {}) {
  const rootFile = '00_events.sql';
  const payload = {
    _comment:
      'GENERATED by scripts/dune-base-setup.mjs — maps each file under dune/base-chain/ to its ' +
      'Dune query id. /api/cron/dune-refresh imports this to know what to re-run daily. Safe to ' +
      'hand-edit only when the queries were created manually on dune.com (free-plan fallback).',
    rootQueryId: queries[rootFile] ?? null,
    dependentQueryIds: Object.entries(queries)
      .filter(([f]) => f !== rootFile)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, id]) => id),
    queries,
  };
  writeFileSync(IDS_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  if (!quiet) console.log(`\n📝 Wrote ${IDS_FILE}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  VERIFY_ONLY = args.includes('--verify');
  const printIdx = args.indexOf('--print');
  const printOnly = printIdx !== -1 ? args[printIdx + 1] : null;

  await loadEnv();

  const contracts = readContracts();
  const files = sqlFiles();
  const ids = readIds();
  const rootFile = '00_events.sql';

  console.log('\nAbaPay — Base-chain Dune dashboard');
  console.log('──────────────────────────────────');
  for (const c of contracts) console.log(`  tracking  ${c.address}  ${c.label}`);
  console.log(`  queries   ${files.length} file(s) in dune/base-chain/\n`);

  if (printOnly) {
    const file = files.find((f) => f.startsWith(printOnly)) ?? printOnly;
    console.log(render(file, contracts));
    return;
  }

  if (dryRun) {
    for (const file of files) {
      console.log(`\n${'═'.repeat(78)}\n── ${file} — ${TITLES[file] ?? file}\n${'═'.repeat(78)}`);
      console.log(render(file, contracts));
    }
    return;
  }

  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) fail('DUNE_API_KEY is not set. Add it to .env.local (Dune → abapay team → Settings → API keys).');

  const description =
    'AbaPay bill payments on Base mainnet only. Source of truth for this SQL is ' +
    'dune/base-chain/ in github.com/investorphem/AbaPay — edit there and re-run ' +
    'scripts/dune-base-setup.mjs rather than editing here.';

  // Root first. The dependents no longer need its id to render — they name its matview —
  // but deploying the source of the data before the things that read it is still the order
  // that leaves the dashboard coherent if the run dies partway.
  // `--verify` skips straight to the run-and-check below: re-PATCHing nine unchanged queries
  // just to confirm they work burns the write rate limit for nothing.
  for (const file of VERIFY_ONLY ? [] : [rootFile, ...files.filter((f) => f !== rootFile)]) {
    const name = TITLES[file] ?? file;
    const sql = render(file, contracts);
    const existing = ids[file];

    const res = existing
      ? await updateQuery(apiKey, existing, name, sql, description)
      : await createQuery(apiKey, name, sql, description);

    if (!res.ok) {
      // 402/403 on create = the Community plan does not include query CRUD over the API.
      if (!existing && (res.status === 402 || res.status === 403)) {
        console.error(
          `\n✗ Dune refused to create "${name}" (HTTP ${res.status}).\n` +
            '  Creating queries over the API needs a paid Dune plan; this account is on the free tier.\n\n' +
            '  Create the 9 queries by hand instead — for each file run:\n' +
            `      node scripts/dune-base-setup.mjs --print ${file.slice(0, 2)}\n` +
            '  paste the output into a new query on dune.com (under the abapay team), save it,\n' +
            '  and record the resulting id in src/lib/dune/base-query-ids.json. Then re-run this\n' +
            '  script — it will PATCH the existing queries from then on.\n'
        );
        process.exit(2);
      }
      // ⚠️ Persist what already succeeded before dying. Without this, a failure partway
      // through leaves queries on Dune that the manifest has never heard of, and the
      // obvious recovery — run it again — creates a duplicate of every one of them.
      writeIds(ids);
      fail(
        `${existing ? 'Updating' : 'Creating'} "${name}" failed (HTTP ${res.status}): ${res.text.slice(0, 300)}\n\n` +
          '  The ids created before this point have been saved, so re-running is safe:\n' +
          '  it will update those and only create what is still missing.'
      );
    }

    const id = existing ?? res.json.query_id;
    ids[file] = id;
    console.log(`  ${existing ? 'updated' : 'created'}  ${String(id).padEnd(9)} ${name}`);
    // Written every iteration, not once at the end, for the same reason.
    writeIds(ids, { quiet: true });
    // Pace the writes rather than relying on the backoff to mop up: on this plan a tight
    // loop trips the limiter almost every time, and waiting 90s to recover costs far more
    // than spacing the calls out does.
    await new Promise((r) => setTimeout(r, 4000));
  }

  writeIds(ids);

  // Verification run. Creating a dashboard that has never returned a row is how you
  // end up publishing an empty one, so prove the root query actually finds the
  // contracts before calling this done.
  console.log('\n▶ Running the root query to verify it returns rows…');
  const rootRun = await executeAndWait(apiKey, ids[rootFile]);
  if (rootRun.state !== 'QUERY_STATE_COMPLETED') {
    console.error(`  ⚠️  Root query ended in state ${rootRun.state}${rootRun.detail ? ` — ${rootRun.detail}` : ''}`);
    console.error('     The queries are deployed, but check them on dune.com before publishing the dashboard.');
    process.exit(3);
  }

  const results = await dune(apiKey, `/execution/${rootRun.executionId}/results?limit=1`);
  const rows = results.json?.result?.metadata?.total_row_count ?? 0;
  console.log(`  ✓ Root query completed — ${rows} event row(s) across the tracked contracts.`);
  if (rows === 0) {
    console.log(
      '  ⚠️  Zero rows. Either these contracts have no activity on Base mainnet yet, or the\n' +
        '     addresses in ABAPAY_BASE_CONTRACTS are wrong (a Celo address will match nothing here).'
    );
  }

  console.log('\n▶ Running the 8 dependent queries…');
  for (const [file, id] of Object.entries(ids)) {
    if (file === rootFile) continue;
    const run = await executeAndWait(apiKey, id, 120_000);
    const ok = run.state === 'QUERY_STATE_COMPLETED';
    console.log(`  ${ok ? '✓' : '✗'} ${String(id).padEnd(9)} ${TITLES[file] ?? file}${ok ? '' : ` — ${run.state}`}`);
  }

  console.log(
    '\nDone. Dashboard: https://dune.com/abapay/abapay-on-base\n' +
      'Charts are added in the web UI — open a query, add a visualization, then "Add to\n' +
      'dashboard". Dune has no API for creating visualizations, so this script cannot do it.\n\n' +
      'Refresh is already wired, in two halves that are easy to confuse:\n' +
      `  data   ${ROOT_TABLE}\n` +
      '         refreshed by Dune\'s own matview cron at 02:00 UTC.\n' +
      '  panels .github/workflows/dune-refresh.yml executes the 8 dependent queries daily.\n' +
      '         A matview refresh does NOT update a panel — both halves are required.\n'
  );
}

main().catch((err) => fail(err?.stack || String(err)));
