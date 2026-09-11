#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deploy the Celo-only AbaPay dashboard's queries to Dune.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   node scripts/dune-celo-setup.mjs            create (or update) all 9 queries
 *   node scripts/dune-celo-setup.mjs --dry-run  print the rendered SQL, call nothing
 *   node scripts/dune-celo-setup.mjs --print 00 print one rendered file, to paste by hand
 *   node scripts/dune-celo-setup.mjs --verify   deploy nothing, just run them and report
 *
 * Mirrors scripts/dune-base-setup.mjs exactly — same idempotency, same rate-limit
 * handling, same retirement mechanism — pointed at dune/celo-chain/ instead. See that
 * file's own comments for the reasoning; only what's actually different is re-explained
 * here.
 *
 * ⚠️ ONE REAL DIFFERENCE FROM BASE: `12_by_rail.sql` (agent vs direct vs x402) is NOT
 * retired here. Base hid it as "too internal for the audience that dashboard is
 * published for" — for THIS dashboard the rail split is the headline metric, not a
 * detail, so it stays live on the dashboard and in the daily refresh. Only
 * 14_by_service.sql and 15_by_contract.sql are retired, matching Base's reasoning for
 * those two specifically.
 *
 * WHY A SCRIPT AND NOT THE DUNE UI: the SQL under `dune/celo-chain/` is the source of
 * truth. Editing a query in the web editor makes the repo silently wrong, and there is
 * no way to diff or review it. Run this instead — it is idempotent: query IDs recorded
 * in `src/lib/dune/celo-query-ids.json` are PATCHed, anything missing is created.
 *
 * ⚠️ The dependent queries read the root query's MATERIALIZED VIEW by name, not through
 * Dune's `query_<id>` syntax. That distinction is load-bearing — see ROOT_TABLE below.
 * The matview is created once, out of band; this script only deploys SQL.
 *
 * ⚠️ Creating queries over the REST API is a PAID Dune feature on some plans. On a plan
 * without it the create call comes back 402/403 — the script detects that and falls
 * back to printing the rendered SQL for you to paste into dune.com by hand, then asks
 * for the IDs to be written into query-ids.json. Nothing is lost either way; the SQL is
 * identical. (Note: the *Dune MCP server*, a separate mechanism from this REST script,
 * was able to create and execute queries live against this account even while this was
 * true of the REST path — see dune/celo-chain/README.md for how the dashboard was
 * actually first stood up.)
 *
 * The API key must belong to the **abapay team** (Dune → team settings → API keys),
 * otherwise the queries land in your personal account instead of the team.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SQL_DIR = join(REPO, 'dune', 'celo-chain');
// Lives under src/ rather than next to the SQL because the cron route imports it —
// a JSON import that reaches outside src/ is exactly the kind of path that breaks a
// production build without breaking `next dev`.
const IDS_FILE = join(REPO, 'src', 'lib', 'dune', 'celo-query-ids.json');

const DUNE_API = 'https://api.dune.com/api/v1';

/**
 * The materialized view of the root query, which all eight dependents read.
 *
 * See scripts/dune-base-setup.mjs's ROOT_TABLE comment for why this must be a matview
 * name and never `query_<root id>` — identical reasoning, different table.
 */
const ROOT_TABLE = 'dune.abapay.result_abapay_celo_events';

/**
 * Retired: taken off the dashboard and hidden on Dune with `is_temp: true`.
 *
 * Only two here, not three — see the file-level note above on why `12_by_rail.sql`
 * stays live for this dashboard specifically. `14_by_service.sql` and
 * `15_by_contract.sql` are retired for the same reason Base retired its equivalents:
 * too internal for the audience this dashboard is published for.
 *
 * ⚠️ `is_temp`, not `is_archived` — see scripts/dune-base-setup.mjs for why.
 */
const RETIRED = new Set(['14_by_service.sql', '15_by_contract.sql']);

/**
 * The description Dune shows under each query's title. Viewer-facing copy, not a code
 * comment — see scripts/dune-base-setup.mjs's own DESCRIPTIONS note.
 */
const DESCRIPTIONS = {
  '00_events.sql':
    'Every AbaPay bill payment settled on Celo mainnet — one row per payment. Covers both ' +
    'settlement rails and every AbaPay contract deployed on Celo, so history stays continuous ' +
    'across redeploys.',
  '10_kpi_summary.sql':
    'Headline totals for AbaPay on Celo: payments settled, unique payers, gross USD volume, ' +
    'and typical payment size.',
  '11_daily_volume.sql':
    'Daily payments and gross USD volume on Celo, with a running cumulative total.',
  '12_by_rail.sql':
    'How AbaPay payments on Celo split between a human signing in the app, an agent spending ' +
    'a granted allowance (Telegram/WhatsApp/X/MCP), and x402 — the agent-to-agent settlement ' +
    'rail that needs no AbaPay account at all.',
  '13_by_token.sql':
    'How AbaPay payments on Celo split between the three stablecoins accepted: USD₮, USDC, and USA₮.',
  '16_dau_wau.sql':
    'Active payers on Celo — daily, weekly and monthly counts of wallets that made at least ' +
    'one payment in each window.',
  '17_new_vs_returning.sql':
    "Each day's payers on Celo split into first-time wallets and wallets that had paid before.",
};

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
// Deliberately NOT inferred from NEXT_PUBLIC_ABAPAY_CELO_ADDRESS alone — see
// scripts/dune-base-setup.mjs's identical reasoning for ABAPAY_BASE_CONTRACTS.
//
//   ABAPAY_CELO_CONTRACTS="0x5df8aE2B…=AbaPayV4 (current),0x42Fa4637…=AbaPayV3 (original)"
//
// Order matters only for readability; labels are what appear on the dashboard.
function readContracts() {
  const raw = process.env.ABAPAY_CELO_CONTRACTS;
  if (!raw || !raw.trim()) {
    fail(
      'ABAPAY_CELO_CONTRACTS is not set.\n\n' +
        'Set it to the AbaPay contract addresses on Celo, comma-separated,\n' +
        'each optionally labelled with "=":\n\n' +
        '  ABAPAY_CELO_CONTRACTS="0xNEW=AbaPayV4 (current),0xOLD=AbaPayV3 (original)"\n'
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
        fail(`"${address}" in ABAPAY_CELO_CONTRACTS is not a 20-byte 0x address.`);
      }
      return { address, label };
    });

  if (contracts.length === 0) fail('ABAPAY_CELO_CONTRACTS parsed to zero addresses.');

  const seen = new Set();
  for (const c of contracts) {
    if (seen.has(c.address)) fail(`${c.address} appears twice in ABAPAY_CELO_CONTRACTS.`);
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
  '00_events.sql': 'AbaPay (Celo) — Events',
  '10_kpi_summary.sql': 'AbaPay (Celo) — KPI Summary',
  '11_daily_volume.sql': 'AbaPay (Celo) — Daily Volume & Transactions',
  '12_by_rail.sql': 'AbaPay (Celo) — Agent vs Direct vs x402 Rail',
  '13_by_token.sql': 'AbaPay (Celo) — Volume by Token',
  '14_by_service.sql': 'AbaPay (Celo) — Volume by Service',
  '15_by_contract.sql': 'AbaPay (Celo) — Volume by Contract',
  '16_dau_wau.sql': 'AbaPay (Celo) — DAU / WAU / MAU',
  '17_new_vs_returning.sql': 'AbaPay (Celo) — New vs Returning Payers',
};

function render(file, contracts) {
  let sql = readFileSync(join(SQL_DIR, file), 'utf8');

  sql = sql.replaceAll('__CONTRACT_LIST__', contracts.map((c) => c.address).join(', '));

  // ⚠️ No table alias on `contract_address` — see scripts/dune-base-setup.mjs's identical
  // note on why this must stay bare and unambiguous.
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

  // 🔴 REGRESSION GUARD — see scripts/dune-base-setup.mjs's identical check.
  const queryRef = sql.replace(/--[^\n]*/g, '').match(/\bquery_\d+\b/);
  if (queryRef) {
    fail(
      `${file} reads the root query as \`${queryRef[0]}\`.\n\n` +
        `  That is a view, not a cached result — Dune re-runs the whole root query inline\n` +
        `  every time this one executes. Read the materialized view instead: write\n` +
        `  __ROOT_TABLE__, which renders to ${ROOT_TABLE}.`
    );
  }

  return sql;
}

// ─── Dune API ──────────────────────────────────────────────────────────────────

/** One Dune API call, retrying transport-level failures. See dune-base-setup.mjs. */
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

/** Run a write call, backing off through Dune's rate limit. See dune-base-setup.mjs. */
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

/**
 * Run a query and wait for it.
 *
 * 🔴 PERFORMANCE TIER: 'free', not 'small' — see src/app/api/cron/dune-refresh/route.ts's
 * own PERFORMANCE comment for why. 'small' started being rejected by this account's plan
 * on 2026-09-10 ("This performance tier is not available with your subscription"); 'free'
 * is what's verified working as of this dashboard's creation (2026-09-11). If this starts
 * failing again, that route's comment is the up-to-date account of what's known.
 */
async function executeAndWait(apiKey, id, budgetMs = 240_000) {
  const started = await withRateLimitRetry(`execute ${id}`, () =>
    dune(apiKey, `/query/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ performance: 'free' }),
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
      'GENERATED by scripts/dune-celo-setup.mjs — maps each file under dune/celo-chain/ to its ' +
      'Dune query id. /api/cron/dune-refresh imports dependentQueryIds to know what to re-run ' +
      'daily. That list is only the queries WITH A PANEL on the dashboard: 14_by_service and ' +
      '15_by_contract are hidden on Dune (is_temp) and appear in `queries` below but never in ' +
      'dependentQueryIds. 12_by_rail is NOT retired here (unlike the Base dashboard) — it is the ' +
      "headline metric for this dashboard, so it stays live. Safe to hand-edit only when the " +
      'queries were created manually on dune.com.',
    rootQueryId: queries[rootFile] ?? null,
    dependentQueryIds: Object.entries(queries)
      .filter(([f]) => f !== rootFile && !RETIRED.has(f))
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

  console.log('\nAbaPay — Celo-chain Dune dashboard');
  console.log('───────────────────────────────────');
  for (const c of contracts) console.log(`  tracking  ${c.address}  ${c.label}`);
  console.log(`  queries   ${files.length} file(s) in dune/celo-chain/\n`);

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

  const toDeploy = VERIFY_ONLY
    ? []
    : [rootFile, ...files.filter((f) => f !== rootFile)].filter((f) => !RETIRED.has(f));

  for (const file of toDeploy) {
    const name = TITLES[file] ?? file;
    const sql = render(file, contracts);
    const description = DESCRIPTIONS[file];
    if (!description) fail(`${file} has no entry in DESCRIPTIONS — add one before deploying.`);
    const existing = ids[file];

    const res = existing
      ? await updateQuery(apiKey, existing, name, sql, description)
      : await createQuery(apiKey, name, sql, description);

    if (!res.ok) {
      if (!existing && (res.status === 402 || res.status === 403)) {
        console.error(
          `\n✗ Dune refused to create "${name}" (HTTP ${res.status}).\n` +
            '  Creating queries over the REST API needs a paid Dune plan.\n\n' +
            '  Create the 9 queries by hand instead — for each file run:\n' +
            `      node scripts/dune-celo-setup.mjs --print ${file.slice(0, 2)}\n` +
            '  paste the output into a new query on dune.com (under the abapay team), save it,\n' +
            '  and record the resulting id in src/lib/dune/celo-query-ids.json. Then re-run this\n' +
            '  script — it will PATCH the existing queries from then on.\n'
        );
        process.exit(2);
      }
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
    writeIds(ids, { quiet: true });
    await new Promise((r) => setTimeout(r, 4000));
  }

  writeIds(ids);

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
      '  ⚠️  Zero rows. Either these contracts have no activity on Celo mainnet yet, or the\n' +
        '     addresses in ABAPAY_CELO_CONTRACTS are wrong (a Base address will match nothing here).'
    );
  }

  const panelFiles = Object.entries(ids).filter(([f]) => f !== rootFile && !RETIRED.has(f));

  console.log(`\n▶ Running the ${panelFiles.length} dependent queries…`);
  for (const [file, id] of panelFiles) {
    const run = await executeAndWait(apiKey, id, 120_000);
    const ok = run.state === 'QUERY_STATE_COMPLETED';
    console.log(`  ${ok ? '✓' : '✗'} ${String(id).padEnd(9)} ${TITLES[file] ?? file}${ok ? '' : ` — ${run.state}`}`);
  }

  console.log(
    '\nDone. Dashboard: https://dune.com/abapay/abapay-on-celo\n' +
      'Charts are added in the web UI, or programmatically via the Dune MCP server\'s\n' +
      'generateVisualization — see dune/celo-chain/README.md.\n\n' +
      'Refresh is already wired, in two halves that are easy to confuse:\n' +
      `  data   ${ROOT_TABLE}\n` +
      '         refreshed by Dune\'s own matview cron.\n' +
      '  panels .github/workflows/dune-refresh.yml executes the dependent queries daily,\n' +
      '         via ?dashboard=celo. A matview refresh does NOT update a panel — both\n' +
      '         halves are required.\n'
  );
}

main().catch((err) => fail(err?.stack || String(err)));
