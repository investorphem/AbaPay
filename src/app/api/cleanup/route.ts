import { NextResponse } from 'next/server';
import { verifyCronRequest } from '@/utils/cronAuth';
import { runCleanup } from '@/lib/jobs/cleanupRun';

// ⚡ Manual / fallback trigger for the cleanup sweeps (src/lib/jobs/cleanupRun.ts).
//
// The every-15-minutes run happens on GitHub Actions (.github/workflows/background-jobs.yml →
// scripts/jobs/run.ts), not here: since 2026-11-18 this all-day work no longer spends the Vercel
// project's Hobby Active CPU. The webhook still runs the stale-preflight and stuck-payment sweeps
// opportunistically (src/lib/cleanupPreflights.ts, src/lib/reconcileStuck.ts).
//
// Callers must present CRON_SECRET (Bearer or x-cron-secret header).

async function handle(req: Request) {
  // Fail-closed cron auth — see src/utils/cronAuth.ts. Previously an unset CRON_SECRET
  // silently disabled the check entirely.
  const unauthorized = verifyCronRequest(req);
  if (unauthorized) return unauthorized;

  const { ok, ...results } = await runCleanup();
  return NextResponse.json(results, { status: ok ? 200 : 500 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
