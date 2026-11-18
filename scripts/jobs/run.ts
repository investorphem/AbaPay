// 🛠️ BACKGROUND-JOB RUNNER — runs AbaPay's all-day work on GitHub Actions, not on Vercel.
//
// 2026-11-18: Vercel paused the project for exceeding the Hobby plan's Active CPU (5h of 4h). The
// steady ~10 min/day came from work that runs every 15 minutes whether or not anyone visits: the
// on-chain index and the cleanup sweeps. They now run here, on the repository's free (public) GitHub
// Actions minutes, with the exact same code as the Vercel routes (src/lib/jobs/*).
//
//   node .jobs-dist/run.cjs [all|onchain-index|cleanup|check] [--backfill]
//
// Built by scripts/jobs/build.mjs. Configuration comes from the environment; on GitHub Actions the
// workflow passes every repository secret as SECRETS_JSON (.github/workflows/background-jobs.yml).

type Job = 'all' | 'onchain-index' | 'cleanup' | 'check';

/** Without these the jobs would talk to the wrong place, or nowhere. */
const REQUIRED = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_NETWORK', 'NEXT_PUBLIC_APP_MODE'];

function loadEnv() {
  // GitHub passes all repository secrets as one JSON object; a secret that is set wins only where the
  // environment doesn't already define the name.
  const raw = process.env.SECRETS_JSON;
  if (raw) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (typeof v === 'string' && v !== '' && !process.env[k]) process.env[k] = v;
      }
    } catch {
      throw new Error('SECRETS_JSON is not valid JSON.');
    }
    delete process.env.SECRETS_JSON;
  }
  // An unset secret arrives as "": treat it as absent, as the app does when a variable isn't set.
  for (const k of Object.keys(process.env)) if (process.env[k] === '') delete process.env[k];
}

function checkEnv(job: Job) {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}. Add them as repository secrets (see the workflow header).`);
  // These jobs deliver bills, settle and refund real payments. Refuse to run them against VTpass's
  // sandbox or a testnet by accident — an unset variable would otherwise quietly mean "sandbox".
  if (job !== 'check') {
    if (process.env.NEXT_PUBLIC_APP_MODE !== 'live') throw new Error(`NEXT_PUBLIC_APP_MODE is "${process.env.NEXT_PUBLIC_APP_MODE}", not "live". Refusing to run production jobs.`);
    if (!['mainnet', 'celo', 'base'].includes(String(process.env.NEXT_PUBLIC_NETWORK))) throw new Error(`NEXT_PUBLIC_NETWORK is "${process.env.NEXT_PUBLIC_NETWORK}", not mainnet. Refusing to run.`);
  }
}

async function main() {
  const job = (process.argv[2] || 'all') as Job;
  if (!['all', 'onchain-index', 'cleanup', 'check'].includes(job)) throw new Error(`Unknown job "${job}".`);
  const backfill = process.argv.includes('--backfill');

  loadEnv();
  checkEnv(job);

  // Imported only now, after the environment is in place: several modules read it when they load.
  const { runOnchainIndex } = await import('@/lib/jobs/onchainIndexRun');
  const { runCleanup } = await import('@/lib/jobs/cleanupRun');
  if (job === 'check') { console.log(JSON.stringify({ check: 'ok', modules: ['onchainIndexRun', 'cleanupRun'] })); return 0; }

  let failed = false;
  if (job === 'all' || job === 'onchain-index') {
    // GitHub Actions has no Vercel 300 s cap. A normal run is caught up in seconds; a backfill keeps
    // going round by round until every chain is caught up.
    for (let round = 1; round <= (backfill ? 40 : 1); round++) {
      const out = await runOnchainIndex({ budgetMs: 600_000 });
      console.log(JSON.stringify({ job: 'onchain-index', round, ...out }));
      if (out.failed) { failed = true; break; }
      if (out.caughtUp) break;
    }
  }
  if (job === 'all' || job === 'cleanup') {
    const out = await runCleanup();
    console.log(JSON.stringify({ job: 'cleanup', ...out }));
    if (!out.ok) failed = true;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`::error::${err instanceof Error ? err.message : String(err)}`); process.exit(1); },
);
