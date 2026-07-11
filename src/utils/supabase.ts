import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// `typeof window === 'undefined'` is true only on the server (Node), false in the browser.
const isServer = typeof window === 'undefined';

// 🔐 FAIL-LOUD CONFIG VALIDATION
//
// Previously the service-role client silently fell back to a dummy key when
// SUPABASE_SERVICE_ROLE_KEY was missing. That turned a *configuration* error into a
// *silent runtime* error: every backend query would fail one-by-one with confusing
// symptoms (e.g. "the admin page renders but no data loads"), instead of failing
// immediately and obviously at boot.
//
// We now surface misconfiguration explicitly. We only enforce the service key on the
// SERVER, because this module is also imported by client components — the browser must
// never see the service-role key, and must not crash for lacking it.
if (!supabaseUrl) {
  const msg = '[CONFIG] NEXT_PUBLIC_SUPABASE_URL is not set. Supabase will not work.';
  if (isServer) console.error(msg);
}
if (!supabaseAnonKey) {
  const msg = '[CONFIG] NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Client-side Supabase reads will fail.';
  if (isServer) console.error(msg);
}
if (isServer && !supabaseServiceKey) {
  // Loud, unmissable server-side error. We don't hard-throw at module load because that
  // would take down every route (including healthy public pages) on a single missing var;
  // instead, any *use* of supabaseAdmin will throw a clear, actionable error (see below).
  console.error(
    '[CRITICAL CONFIG] SUPABASE_SERVICE_ROLE_KEY is missing. ' +
    'All backend/admin database operations WILL fail. ' +
    'Set it in your environment (and ensure it is enabled for the Production environment on Vercel).'
  );
}

// 1. STANDARD CLIENT (browser-safe, RLS-enforced)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 2. SERVICE-ROLE CLIENT (server only — bypasses RLS)
//
// If the service key is absent we return a Proxy that throws a clear, descriptive error
// the moment anything tries to use it. This is far better than the old dummy-key client,
// which *looked* valid and then failed opaquely on every individual query.
function createUnconfiguredAdminClient(): any {
  const err = () => {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. supabaseAdmin cannot be used. ' +
      'Set SUPABASE_SERVICE_ROLE_KEY in your server environment.'
    );
  };
  return new Proxy({}, { get: err, apply: err });
}

export const supabaseAdmin: any =
  supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : createUnconfiguredAdminClient();
