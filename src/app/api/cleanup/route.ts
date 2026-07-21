import { NextResponse } from 'next/server';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';
import { reconcileStuckProcessing } from '@/lib/reconcileStuck';

// ⚡ Manual / optional-cron trigger for the stale-preflight + stuck-PROCESSING sweeps.
//
// NOTE: This does NOT require a Vercel cron. Both sweeps also run automatically and
// opportunistically from inside the webhook (see src/lib/cleanupPreflights.ts and
// src/lib/reconcileStuck.ts), so on the free plan you can rely on that alone — but since
// reconcileStuckProcessing is the safety net for a genuinely stuck payment (money already
// moved, delivery unconfirmed), an external free cron hitting this every few minutes
// (e.g. cron-job.org / GitHub Actions) is strongly recommended rather than depending
// entirely on incidental webhook traffic to trigger it.
//
// If CRON_SECRET is set, callers must present it (Bearer or x-cron-secret header).

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

  const [preflightResult, stuckResult] = await Promise.all([
    cleanupStalePreflights({ force: true }),
    reconcileStuckProcessing({ force: true }),
  ]);
  const ok = preflightResult.ok && stuckResult.ok;
  return NextResponse.json({ preflight: preflightResult, stuckProcessing: stuckResult }, { status: ok ? 200 : 500 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
