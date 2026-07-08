import { NextResponse } from 'next/server';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';

// ⚡ Manual / optional-cron trigger for the stale-preflight sweep.
//
// NOTE: This does NOT require a Vercel cron. The same cleanup runs automatically
// and opportunistically from inside the webhook (see src/lib/cleanupPreflights.ts),
// so on the free plan you can simply rely on that. This endpoint remains available
// for manual runs, an external free cron (e.g. cron-job.org / GitHub Actions), or a
// real Vercel cron if you later upgrade.
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

  const result = await cleanupStalePreflights({ force: true });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
