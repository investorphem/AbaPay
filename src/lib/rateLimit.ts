import { supabaseAdmin } from '@/utils/supabase';

// 🛡️ RATE LIMITING (Supabase-backed, serverless-safe, zero new dependencies)
//
// WHY NOT IN-MEMORY: Vercel runs each request on a potentially different, cold-startable
// instance. A Map/counter in module scope is per-instance and resets constantly, so it
// provides no real limit. State must be shared — we use the Postgres DB we already have.
//
// WHAT THIS PROTECTS: endpoints that cost real money or send real messages when abused:
//   • /api/verify/*      → each call hits VTpass (billable)
//   • /api/variations    → hits VTpass (billable)
//   • /api/verify/request→ sends a WhatsApp OTP (billable; SMS-bomb vector)
//   • /api/deai/intent   → burns Gemini quota
//
// REQUIRED TABLE (run once in the Supabase SQL editor):
//
//   create table if not exists public.rate_limits (
//     key         text primary key,
//     count       integer not null default 0,
//     window_start timestamptz not null default now()
//   );
//
// FAIL-OPEN BY DESIGN: if the rate-limit table is unavailable, we allow the request
// rather than taking the whole app down. Rate limiting is an abuse control, not an
// authentication control — it must never become a single point of failure. (Auth checks
// elsewhere in the app correctly fail CLOSED; this one intentionally does not.)

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Derive a best-effort client identifier. Vercel sets x-forwarded-for.
 * Not spoof-proof, but adequate for abuse throttling.
 */
export function getClientKey(req: Request, scope: string): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  const ip = fwd.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  return `${scope}:${ip}`;
}

/**
 * Fixed-window rate limit.
 * @param key      unique bucket key (use getClientKey)
 * @param limit    max requests allowed per window
 * @param windowSeconds  window length
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Date.now();

  try {
    const { data } = await supabaseAdmin
      .from('rate_limits')
      .select('count, window_start')
      .eq('key', key)
      .maybeSingle();

    // Explicitly shape the row. The project has no generated Supabase types, so we
    // avoid relying on inference here (which would be an implicit `any` under strict mode).
    const existing = data as { count: number | null; window_start: string | null } | null;

    // No record, or the previous window has fully elapsed → start a fresh window.
    const windowStart = existing?.window_start ? new Date(existing.window_start).getTime() : 0;
    const windowExpired = !existing || now - windowStart >= windowSeconds * 1000;

    if (windowExpired) {
      await supabaseAdmin
        .from('rate_limits')
        .upsert({ key, count: 1, window_start: new Date(now).toISOString() }, { onConflict: 'key' });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    const count = Number(existing.count) || 0;

    if (count >= limit) {
      const elapsed = now - windowStart;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowSeconds * 1000 - elapsed) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    await supabaseAdmin
      .from('rate_limits')
      .update({ count: count + 1 })
      .eq('key', key);

    return { allowed: true, remaining: limit - (count + 1), retryAfterSeconds: 0 };
  } catch (err) {
    // Fail OPEN — see note above.
    console.error('[rateLimit] check failed, allowing request:', err);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/**
 * Convenience wrapper: returns a 429 Response if the caller is over the limit,
 * or null if the request may proceed.
 */
export async function enforceRateLimit(
  req: Request,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<Response | null> {
  const result = await rateLimit(getClientKey(req, scope), limit, windowSeconds);
  if (result.allowed) return null;

  return new Response(
    JSON.stringify({ success: false, error: 'Too many requests. Please slow down and try again shortly.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfterSeconds),
      },
    }
  );
}
