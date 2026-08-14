import { NextResponse } from 'next/server';

// 🔐 CRON / SCHEDULED-JOB AUTH — FAIL CLOSED.
//
// 🔴 THE BUG THIS FIXES: /api/cleanup, /api/schedules/run, /api/schedules/run-instant and
// /api/cron/dune-refresh each carried their own copy of:
//
//     const cronSecret = process.env.CRON_SECRET;
//     if (cronSecret) { ...check it... }        // <-- no secret configured = NO CHECK AT ALL
//
// So a missing, renamed, or typo'd CRON_SECRET silently turned every one of those endpoints
// into an open, unauthenticated trigger — with no error, no log, and nothing in the test suite
// that would notice. That matters most for the two schedule runners, which drive AUTONOMOUS
// spending from users' on-chain allowances.
//
// src/utils/internalAuth.ts already got this right ("no secret material configured at all —
// fail closed rather than open"). This is the same rule, applied to the cron surface, in one
// place so the four call sites cannot drift apart again.
//
// Accepts either `Authorization: Bearer <secret>` (what Vercel Cron and most hosted cron
// providers send) or `x-cron-secret: <secret>` (what a plain curl/cron-job.org job can set).

export function verifyCronRequest(req: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error(
      '[SECURITY] CRON_SECRET is not configured — refusing the request. ' +
      'Set CRON_SECRET in the environment and on the caller; this endpoint will not run unauthenticated.'
    );
    // 500, deliberately NOT 503. .github/workflows/dune-refresh.yml treats a 503 from
    // /api/cron/dune-refresh as the benign "that dashboard has no query ids deployed yet"
    // case and downgrades it to a warning. Returning 503 here would make a missing
    // CRON_SECRET — a genuine misconfiguration that stops every scheduled job — show up as
    // a green run with a warning, which is exactly the kind of silent failure this whole
    // fail-closed change exists to prevent.
    return NextResponse.json(
      { error: 'Scheduled endpoints are not configured on this deployment (CRON_SECRET missing).' },
      { status: 500 }
    );
  }

  const auth = req.headers.get('authorization') || '';
  const headerSecret = req.headers.get('x-cron-secret') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : headerSecret;

  if (!provided || !timingSafeEqualStr(provided, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null; // authorised — caller proceeds
}

// Constant-time comparison, so a caller can't recover the secret byte-by-byte from response
// timing. Length is compared first (and leaks only the length, which is not sensitive here).
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
