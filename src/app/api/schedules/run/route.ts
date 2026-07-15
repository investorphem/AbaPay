import { NextResponse } from 'next/server';
import { runScheduledBills } from '@/lib/scheduler';

// ⚡ Triggers the scheduled-bill check: reads on-chain balances, warns on shortfalls,
// and sends one-tap payment links for bills due today.
//
// Trigger with a free external cron (cron-job.org, GitHub Actions) once or twice daily —
// no paid Vercel cron required. Protect with CRON_SECRET.
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

  const result = await runScheduledBills();
  return NextResponse.json({ success: true, ...result });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
