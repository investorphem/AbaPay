import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ STALE PREFLIGHT CLEANUP
//
// When a user reaches the payment screen we create a PENDING record with a
// placeholder `preflight_<wallet>_<ts>` tx_hash BEFORE they sign. If they then
// close the app / reject the wallet prompt / lose connection, no real transaction
// is ever broadcast — so the blockchain never sees it and the Alchemy webhook
// never fires to resolve it. Without cleanup, that row sits PENDING forever,
// polluting history and analytics and blocking the abandoned-intent rescue from
// confidently matching future real payments.
//
// This route marks any preflight-only PENDING record older than the cutoff as
// EXPIRED. Because it ONLY ever touches rows whose tx_hash still starts with
// "preflight_", it can never expire a real, broadcast transaction (those have had
// their tx_hash rewritten to the real 0x… hash by the frontend or the webhook
// rescue). No funds are ever involved — by definition nothing was sent on-chain.
//
// Trigger options:
//   • Vercel Cron (recommended): add to vercel.json ->
//       { "crons": [{ "path": "/api/cleanup", "schedule": "*/15 * * * *" }] }
//   • Manual/authenticated call with header  x-cron-secret: <CRON_SECRET>
//
// Default cutoff is 20 minutes: comfortably longer than the webhook's own 15s
// sleep + retry window, so a legitimately slow-to-confirm payment is never caught.

const STALE_MINUTES = 20;

async function runCleanup() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data: expired, error } = await supabase
    .from('transactions')
    .update({ status: 'EXPIRED', error_code: 'PREFLIGHT_UNCONFIRMED', api_response: 'No on-chain transaction observed — user never completed payment.' })
    .eq('status', 'PENDING')
    .like('tx_hash', 'preflight_%')
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('Preflight cleanup error:', error.message);
    return { ok: false, error: error.message };
  }

  const count = expired?.length || 0;
  if (count > 0) {
    try { await sendTelegramAlert(`🧹 *PREFLIGHT CLEANUP*\nExpired ${count} abandoned pre-flight intent(s) older than ${STALE_MINUTES} min (no on-chain tx ever seen).`); } catch {}
  }
  return { ok: true, expired: count };
}

// GET is convenient for Vercel Cron (which issues GET requests).
export async function GET(req: Request) {
  // If a CRON_SECRET is configured, require it (Vercel Cron sends it via the
  // Authorization header automatically when set as a project env var).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization') || '';
    const headerSecret = req.headers.get('x-cron-secret') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : headerSecret;
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const result = await runCleanup();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(req: Request) {
  return GET(req);
}
