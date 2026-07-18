import { NextResponse } from 'next/server';
import { runScheduledBills } from '@/lib/scheduler';

// ⚡ ONE-OFF SCHEDULE RUNNER — "buy me MTN airtime in the next 10 minutes."
//
// Unlike the daily/twice-daily /api/schedules/run (recurring bills — monthly/weekly/daily),
// a one-off schedule needs to be checked at minute granularity to actually fire close to the
// time the user asked for. Trigger this with a free external cron (cron-job.org) every
// 1-5 minutes — no paid Vercel plan required, same pattern as /api/schedules/run and
// /api/cleanup. Scoped to `frequency = 'once'` rows only, so it stays cheap even at that
// frequency: most ticks will find nothing due and exit immediately.
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

  const result = await runScheduledBills({ scope: 'oneoff' });
  return NextResponse.json({ success: true, ...result });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
