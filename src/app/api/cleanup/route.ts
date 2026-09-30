import { NextResponse } from 'next/server';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';
import { reconcileStuckProcessing } from '@/lib/reconcileStuck';
import { checkProviderBalances } from '@/lib/balanceAlerts';
import { reconcileRecordedRefunds } from '@/lib/refundVerify';
import { reconcileX402Intents } from '@/lib/reconcileX402';
import { pruneWebhookEvents } from '@/lib/webhookEvents';
import { verifyCronRequest } from '@/utils/cronAuth';

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
  // Fail-closed cron auth — see src/utils/cronAuth.ts. Previously an unset CRON_SECRET
  // silently disabled the check entirely.
  const unauthorized = verifyCronRequest(req);
  if (unauthorized) return unauthorized;

  // ⚡ Balance checks deliberately do NOT get force:true — checkProviderBalances runs its
  // check every call, but the ALERT itself keeps its own 6h per-provider cooldown regardless
  // of how often this endpoint is hit, so a cron running every few minutes can't spam Telegram
  // every time the float is confirmed low.
  const [preflightResult, stuckResult, balanceResult, refundResult, x402Result] = await Promise.all([
    cleanupStalePreflights({ force: true }),
    reconcileStuckProcessing({ force: true }),
    checkProviderBalances(),
    // Finishes refunds that were broadcast on-chain but never recorded — see refundVerify.ts.
    reconcileRecordedRefunds({ force: true }),
    // Finishes or closes x402 payments whose request died after the intent was recorded.
    reconcileX402Intents({ force: true }),
    // Drops chat-webhook de-dup rows past every platform's retry window. Best-effort.
    pruneWebhookEvents(),
  ]);
  const ok = preflightResult.ok && stuckResult.ok && balanceResult.ok && refundResult.ok && x402Result.ok;
  return NextResponse.json({ preflight: preflightResult, stuckProcessing: stuckResult, balances: balanceResult, refunds: refundResult, x402Intents: x402Result }, { status: ok ? 200 : 500 });
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
