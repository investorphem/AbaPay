import { NextResponse } from 'next/server';
import { runScheduledBills } from '@/lib/scheduler';
import { verifyCronRequest } from '@/utils/cronAuth';

// ⚡ Triggers the scheduled-bill check: reads on-chain balances, warns on shortfalls,
// and sends one-tap payment links for bills due today.
//
// Trigger with a free external cron (cron-job.org, GitHub Actions) once or twice daily —
// no paid Vercel cron required. Protect with CRON_SECRET.
async function handle(req: Request) {
  // 🔐 Fail-closed — see src/utils/cronAuth.ts. This endpoint drives AUTONOMOUS spending from
  // users' on-chain allowances, so an unset CRON_SECRET must refuse the request, not skip the
  // check (which is what the previous `if (cronSecret)` shape did).
  const unauthorized = verifyCronRequest(req);
  if (unauthorized) return unauthorized;

  // One-off ("in 10 minutes") schedules are handled by the separate, minute-cadence
  // /api/schedules/run-instant — this daily/twice-daily cron only needs to scan recurring ones.
  const result = await runScheduledBills({ scope: 'recurring' });
  return NextResponse.json({ success: true, ...result });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
