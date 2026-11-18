import 'server-only';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';
import { reconcileStuckProcessing } from '@/lib/reconcileStuck';
import { expireUnseenPayments } from '@/lib/expireUnseenPayments';
import { checkProviderBalances } from '@/lib/balanceAlerts';
import { reconcileRecordedRefunds } from '@/lib/refundVerify';
import { reconcileX402Intents } from '@/lib/reconcileX402';
import { reconcileNimIntents } from '@/lib/nimSettle';
import { pruneWebhookEvents } from '@/lib/webhookEvents';
import { pruneIdempotencyKeys } from '@/lib/idempotency';
import { pruneDoneJobs } from '@/lib/jobs';
import { pingDeadman } from '@/lib/deadman';

// ⚡ CLEANUP SWEEPS — stale pre-flights, stuck payments, provider balances, recorded refunds, x402
// and NIM intents, unseen payment hashes, and pruning. Shared by /api/cleanup (manual calls) and the
// GitHub Actions job runner (scripts/jobs/run.ts), which runs it every 15 minutes since 2026-11-18
// so this all-day work no longer spends the Vercel project's Hobby Active CPU.

export async function runCleanup() {
  // ⚡ Balance checks deliberately do NOT get force:true — checkProviderBalances runs its
  // check every call, but the ALERT itself keeps its own 6h per-provider cooldown regardless
  // of how often this runs, so a frequent schedule can't spam Telegram every time the float is
  // confirmed low.
  const [preflight, stuckProcessing, balances, refunds, x402Intents, nimIntents, unseenPayments] = await Promise.all([
    cleanupStalePreflights({ force: true }),
    reconcileStuckProcessing({ force: true }),
    checkProviderBalances(),
    // Finishes refunds that were broadcast on-chain but never recorded — see refundVerify.ts.
    reconcileRecordedRefunds({ force: true }),
    // Finishes or closes x402 payments whose request died after the intent was recorded.
    reconcileX402Intents({ force: true }),
    // Settles NIM payments whose app closed before reporting them, expires unpaid NIM orders.
    reconcileNimIntents({ force: true }),
    // Closes Celo/Base orders whose payment hash never appeared on chain (src/lib/expireUnseenPayments.ts).
    expireUnseenPayments(),
    // Drops chat-webhook de-dup rows past every platform's retry window. Best-effort.
    pruneWebhookEvents(),
    // Drops expired MCP idempotency keys (src/lib/idempotency.ts). Best-effort.
    pruneIdempotencyKeys(),
    // Drops fulfilment jobs finished more than 30 days ago (src/lib/jobs.ts).
    pruneDoneJobs(),
  ]);
  const ok = preflight.ok && stuckProcessing.ok && balances.ok && refunds.ok && x402Intents.ok && nimIntents.ok && unseenPayments.ok;
  // Dead-man ping: HEALTHCHECK_URL_CLEANUP (src/lib/deadman.ts).
  await pingDeadman('CLEANUP', ok);
  return { ok, preflight, stuckProcessing, balances, refunds, x402Intents, nimIntents, unseenPayments };
}
