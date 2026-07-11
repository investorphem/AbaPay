import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// `typeof window === 'undefined'` is true only on the server (Node), false in the browser.
const isServer = typeof window === 'undefined';

// 🔐 FAIL-LOUD CONFIG VALIDATION
//
// The service-role client previously fell back to a dummy key when
// SUPABASE_SERVICE_ROLE_KEY was missing. That turned a *configuration* error into a
// *silent runtime* error: every backend query failed one-by-one with confusing symptoms
// (e.g. "the admin page renders but no data loads") instead of failing obviously.
//
// We now surface misconfiguration loudly. The service key is only enforced on the SERVER,
// because this module is also imported by client components — the browser must never see
// the service-role key, and must not crash for lacking it.
if (isServer && !supabaseUrl) {
  console.error('[CONFIG] NEXT_PUBLIC_SUPABASE_URL is not set. Supabase will not work.');
}
if (isServer && !supabaseAnonKey) {
  console.error('[CONFIG] NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Client-side Supabase reads will fail.');
}
if (isServer && !supabaseServiceKey) {
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
// When the service key is absent we still construct a real client (so the module stays
// fully typed and importable from client components), but we point it at an obviously
// invalid key AND log the CRITICAL error above. Any query will then fail fast with a
// clear auth error rather than silently returning empty data.
//
// Typed as SupabaseClient — NOT `any` — so that every call site keeps full type
// inference. (Typing this as `any` silently strips types from `.rpc()`/`.from()`
// callbacks across the codebase and breaks strict-mode builds.)
export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey || 'MISSING_SUPABASE_SERVICE_ROLE_KEY'
);
