import 'server-only';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { supabaseAdmin } from '@/utils/supabase';

// ⚡ IDEMPOTENT MONEY-MOVING CALLS (migration 031).
//
// An MCP client that times out waiting for pay_bill and retries — or a transport that
// redelivers — used to run the payment again. Now every pay_bill / pay_bill_batch /
// schedule_bill runs under a key:
//   • the caller's own `idempotency_key` (8–128 chars), remembered for 24h; or
//   • with none, a key DERIVED from the credential + the request itself, remembered for 2
//     minutes — enough to absorb a naive retry, short enough that paying the same bill again
//     on purpose later just works.
//
// The key is CLAIMED (insert, unique on scope + key) before the call does anything, so two
// concurrent identical calls cannot both run: the second is told the first is in progress.
//
// What gets remembered is decided by whether money MAY have moved, not by success/failure:
// the call's code marks the point of no return (markCommitted — executeAgentPayment and the
// schedule insert call it). A call that ended BEFORE that point (wrong PIN, validation,
// service paused) releases the key, so fixing the request and retrying with the same key runs
// normally. A call that reached it stores its result — success or failure — and every repeat
// gets that result back instead of paying again.
//
// The request hash deliberately leaves out the PIN, the api_key and the key itself: a stored
// hash that included a 6-digit PIN could be brute-forced back to the PIN.

const EXPLICIT_TTL_MS = 24 * 3600_000;
const DERIVED_TTL_MS = 2 * 60_000;
// An IN_PROGRESS claim must outlive the slowest call (a relay waits for its receipt), or a
// retry could find it "expired" mid-flight and run the payment a second time.
const IN_PROGRESS_TTL_MS = 15 * 60_000;
const OMIT_FROM_HASH = new Set(['pin', 'api_key', 'idempotency_key']);

const committed = new AsyncLocalStorage<{ committed: boolean }>();

/** Call at the point after which a repeat must NOT run again (money may move / a row was saved). */
export function markCommitted(): void {
  const store = committed.getStore();
  if (store) store.committed = true;
}

function stable(v: any): any {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().filter((k) => !OMIT_FROM_HASH.has(k)).reduce((o: any, k) => { o[k] = stable(v[k]); return o; }, {});
  }
  return v;
}

export function requestHash(tool: string, args: any): string {
  return crypto.createHash('sha256').update(JSON.stringify({ tool, args: stable(args || {}) })).digest('hex');
}

export type IdempotencyOutcome<T> =
  | { kind: 'RAN'; result: T }
  | { kind: 'REPLAY'; result: T; ageSeconds: number }
  | { kind: 'IN_PROGRESS' }
  | { kind: 'MISMATCH' };

/**
 * Run `fn` at most once per (scope, key). `scope` identifies the credential (never the raw
 * api_key). With no explicit key, a derived one is used — see the header.
 */
export async function runIdempotent<T>(
  scope: string,
  tool: string,
  args: any,
  explicitKey: string | null,
  fn: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const hash = requestHash(tool, args);
  const key = explicitKey ? `k:${tool}:${explicitKey}` : `d:${hash}`;
  const ttl = explicitKey ? EXPLICIT_TTL_MS : DERIVED_TTL_MS;

  const claim = async () => supabaseAdmin.from('idempotency_keys').insert({
    scope, key, request_hash: hash, status: 'IN_PROGRESS',
    expires_at: new Date(Date.now() + Math.max(ttl, IN_PROGRESS_TTL_MS)).toISOString(),
  });

  let { error } = await claim();
  if (error && error.code === '23505') {
    const { data: existing } = await supabaseAdmin
      .from('idempotency_keys').select('*').eq('scope', scope).eq('key', key).maybeSingle();
    const row = existing as any;
    if (row && new Date(row.expires_at).getTime() <= Date.now()) {
      // Expired: remove exactly that row (not a newer one) and claim afresh.
      await supabaseAdmin.from('idempotency_keys').delete().eq('scope', scope).eq('key', key).eq('expires_at', row.expires_at);
      ({ error } = await claim());
    } else if (row) {
      if (row.request_hash !== hash) return { kind: 'MISMATCH' };
      if (row.status === 'DONE') {
        return { kind: 'REPLAY', result: row.response as T, ageSeconds: Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000) };
      }
      return { kind: 'IN_PROGRESS' };
    }
  }
  if (error && error.code === '23505') return { kind: 'IN_PROGRESS' }; // lost a race to re-claim
  if (error) {
    // Can't record the key — refuse rather than run a money-moving call with no protection
    // against the very retry this exists to catch.
    console.error(`[Idempotency] claim failed (${tool}):`, error.message);
    throw new Error('IDEMPOTENCY_UNAVAILABLE');
  }

  const ctx = { committed: false };
  let result: T;
  try {
    result = await committed.run(ctx, fn);
  } catch (err) {
    if (!ctx.committed) await release(scope, key);
    throw err;
  }

  if (!ctx.committed) {
    await release(scope, key);
  } else {
    const { error: saveErr } = await supabaseAdmin.from('idempotency_keys')
      .update({ status: 'DONE', response: result as any, expires_at: new Date(Date.now() + ttl).toISOString() })
      .eq('scope', scope).eq('key', key);
    // Left IN_PROGRESS on a failed save: repeats are refused as "in progress" until it
    // expires — never re-run.
    if (saveErr) console.error(`[Idempotency] could not store result (${tool}):`, saveErr.message);
  }
  return { kind: 'RAN', result };
}

async function release(scope: string, key: string) {
  try { await supabaseAdmin.from('idempotency_keys').delete().eq('scope', scope).eq('key', key); }
  catch (err) { console.error('[Idempotency] release failed:', err); }
}

/** Prune expired keys. Called from /api/cleanup. */
export async function pruneIdempotencyKeys(): Promise<void> {
  try { await supabaseAdmin.from('idempotency_keys').delete().lt('expires_at', new Date().toISOString()); }
  catch (err) { console.error('[Idempotency] prune failed:', err); }
}
