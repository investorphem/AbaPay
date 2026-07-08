import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ STALE PREFLIGHT CLEANUP (shared helper)
//
// Pre-flight intents (PENDING rows with a `preflight_<wallet>_<ts>` tx_hash) are
// created before the user signs. If they abandon/​reject/​disconnect, no on-chain
// transaction is ever broadcast, so nothing ever resolves them — they'd sit
// PENDING forever. This marks any such row older than STALE_MINUTES as EXPIRED.
//
// It ONLY ever touches rows whose tx_hash still starts with "preflight_", so a
// real, broadcast transaction (whose hash was rewritten to the real 0x… value by
// the frontend or the webhook rescue) can NEVER be expired. No funds are involved.
//
// This runs opportunistically from inside the webhook (no paid Vercel cron
// required), and is also exposed via /api/cleanup for manual or scheduled runs.

const STALE_MINUTES = 20;

// Lightweight throttle so a burst of webhook calls doesn't hammer the DB with
// redundant sweeps. Module-scoped; resets on cold start, which is fine.
let lastRun = 0;
const MIN_INTERVAL_MS = 5 * 60 * 1000; // at most once every 5 minutes per warm instance

export async function cleanupStalePreflights(opts: { force?: boolean } = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRun < MIN_INTERVAL_MS) {
    return { ok: true, skipped: true, expired: 0 };
  }
  lastRun = now;

  const cutoff = new Date(now - STALE_MINUTES * 60 * 1000).toISOString();

  const { data: expired, error } = await supabase
    .from('transactions')
    .update({ status: 'EXPIRED', error_code: 'PREFLIGHT_UNCONFIRMED', api_response: 'No on-chain transaction observed — user never completed payment.' })
    .eq('status', 'PENDING')
    .like('tx_hash', 'preflight_%')
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('Preflight cleanup error:', error.message);
    return { ok: false, error: error.message, expired: 0 };
  }

  const count = expired?.length || 0;
  if (count > 0) {
    try { await sendTelegramAlert(`🧹 *PREFLIGHT CLEANUP*\nExpired ${count} abandoned pre-flight intent(s) older than ${STALE_MINUTES} min (no on-chain tx ever seen).`); } catch {}
  }
  return { ok: true, expired: count };
}
