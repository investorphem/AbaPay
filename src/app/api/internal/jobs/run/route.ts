import { NextResponse } from 'next/server';
import { verifyCronRequest } from '@/utils/cronAuth';
import { runDueJobs } from '@/lib/jobs';
import { withDeadman } from '@/lib/deadman';

// 🧾 FULFILMENT WORKER (M6). Call every minute from the external cron (same pattern and the
// same CRON_SECRET as /api/schedules/run-instant). It accepts no job payloads, only runs jobs
// already in the table, and fails closed without the secret (src/utils/cronAuth.ts).
//
// FULFILMENT_WORKER_ENABLED=false turns it into a no-op (rollback switch). Pings
// HEALTHCHECK_URL_JOBS so a worker that stops running gets noticed.

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handle(req: Request) {
  const unauthorized = verifyCronRequest(req);
  if (unauthorized) return unauthorized;

  if (process.env.FULFILMENT_WORKER_ENABLED === 'false') {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const result = await withDeadman('JOBS', (r) => r.ok, () => runDueJobs());
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
