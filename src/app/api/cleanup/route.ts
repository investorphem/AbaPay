import { NextResponse } from 'next/server';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';
import { reconcileStuckProcessing } from '@/lib/reconcileStuck';
import { checkProviderBalances } from '@/lib/balanceAlerts';

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

  // ⚡ Balance checks deliberately do NOT get force:true — checkProviderBalances runs its
  // check every call, but the ALERT itself keeps its own 6h per-provider cooldown regardless
  // of how often this endpoint is hit, so a cron running every few minutes can't spam Telegram
  // every time the float is confirmed low.
  const [preflightResult, stuckResult, balanceResult] = await Promise.all([
    cleanupStalePreflights({ force: true }),
    reconcileStuckProcessing({ force: true }),
    checkProviderBalances(),
  ]);
  const ok = preflightResult.ok && stuckResult.ok && balanceResult.ok;
  return NextResponse.json({ preflight: preflightResult, stuckProcessing: stuckResult, balances: balanceResult }, { status: ok ? 200 : 500 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
