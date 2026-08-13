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
 * Derive a client identifier that the client cannot choose for itself.
 *
 * 🔴 THE BUG THIS FIXES: this used to read `x-forwarded-for.split(',')[0]` — the LEFTMOST
 * entry. In a forwarded-for chain the leftmost value is the one the ORIGINAL CALLER supplied,
 * so any client could send its own `X-Forwarded-For: <anything>` header and the proxy would
 * simply append the real address to the right of it. Rotating that value per request gave
 * every request a brand-new bucket, which defeated the throttle completely — on the billable
 * VTpass lookups, on the OTP send path (an SMS-bomb vector), and on every other endpoint this
 * is supposed to protect.
 *
 * Order of preference, most trustworthy first:
 *   1. `x-vercel-forwarded-for` — set by Vercel's edge; a client-supplied copy is overwritten.
 *   2. `x-real-ip`             — likewise set by the platform, single value.
 *   3. RIGHTMOST `x-forwarded-for` entry — the hop nearest our trusted proxy, i.e. the part of
 *      the chain the caller could not have forged. (Never the leftmost.)
 */
export function getClientKey(req: Request, scope: string): string {
  const vercelIp = (req.headers.get('x-vercel-forwarded-for') || '').trim();
  const realIp = (req.headers.get('x-real-ip') || '').trim();

  let ip = vercelIp || realIp;

  if (!ip) {
    const chain = (req.headers.get('x-forwarded-for') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    ip = chain.length ? chain[chain.length - 1] : '';
  }

  return `${scope}:${ip || 'unknown'}`;
}

/**
 * Fixed-window rate limit.
 * @param key      unique bucket key (use getClientKey)
 * @param limit    max requests allowed per window
 * @param windowSeconds  window length
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Date.now();

  // ⚡ ATOMIC PATH (preferred) — one statement, incremented under a row lock inside Postgres.
  //
  // 🔴 THE RACE THIS FIXES: the legacy path below reads the counter, decides in JS, then
  // writes. Concurrent requests all read the same value and all conclude they're under the
  // limit, so a burst — precisely what a throttle exists to stop — sails through. See
  // supabase/migrations/023_rate_limit_atomic_increment.sql.
  //
  // Falls back to the legacy read-modify-write if the function isn't deployed yet, so shipping
  // this code before running the migration degrades to the old behaviour rather than breaking.
  try {
    const { data, error } = await supabaseAdmin.rpc('rate_limit_hit', {
      p_key: key,
      p_window_seconds: windowSeconds,
    });

    if (!error && data) {
      const row = Array.isArray(data) ? data[0] : data;
      const used = Number((row as any)?.used);
      if (Number.isFinite(used)) {
        if (used > limit) {
          const windowStart = new Date((row as any).window_start).getTime();
          const elapsed = now - windowStart;
          const retryAfterSeconds = Math.max(1, Math.ceil((windowSeconds * 1000 - elapsed) / 1000));
          return { allowed: false, remaining: 0, retryAfterSeconds };
        }
        return { allowed: true, remaining: Math.max(0, limit - used), retryAfterSeconds: 0 };
      }
    }

    if (error) {
      console.warn('[rateLimit] rate_limit_hit RPC unavailable, falling back to non-atomic path:', error.message);
    }
  } catch (rpcErr) {
    console.warn('[rateLimit] rate_limit_hit RPC threw, falling back to non-atomic path:', (rpcErr as Error).message);
  }

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
 * Convenience wrapper: returns a 429 Response if the caller (identified by an
 * already-derived key) is over the limit, or null if the request may proceed.
 */
export async function enforceRateLimitByKey(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<Response | null> {
  const result = await rateLimit(key, limit, windowSeconds);
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

/**
 * Convenience wrapper: returns a 429 Response if the caller is over the limit,
 * or null if the request may proceed. Keys by IP — use enforceRateLimitByKey
 * directly for a different identity (e.g. wallet address).
 */
export async function enforceRateLimit(
  req: Request,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<Response | null> {
  return enforceRateLimitByKey(getClientKey(req, scope), limit, windowSeconds);
}
