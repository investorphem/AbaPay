import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { executeVend } from '@/lib/vend';
import { vendInputFromRow } from '@/lib/vendInput';
import { reconcileStuckRow } from '@/lib/reconcileStuck';
import { explorerBaseFor } from '@/lib/chain';
import { sendTelegramAlert } from '@/lib/telegram';
import { log, metric } from '@/lib/log';
import { getHeaders } from '@/lib/vtpass';
import { requeryMonnifyTransfer } from '@/lib/monnifyVend';

// 🧾 FULFILMENT JOBS (M6). See migration 034 for the why.
//
// Every proven payment gets ONE job (created by a trigger, in the same transaction as the
// claim). Normally the inline request delivers the bill within seconds and the job just
// confirms that. When the request died, the job finishes the work:
//
//   • row already finished (SUCCESS, FAILED_VENDING, REFUNDED, …) → job done, nothing to do;
//   • row PROCESSING and NEVER dispatched to the provider (no vend_dispatched_at) → deliver it
//     now. executeVend's dispatch guard means this can't double up with a late inline request;
//   • row dispatched but unfinished → the same requery-first reconciler the 5-minute sweep uses
//     (reconcileStuckRow). It never re-sends; "still processing at the provider" retries later.
//
// Retries back off exponentially (30s doubling, capped at 1h). After max_attempts the job is
// parked as needs_review and the operator is told once.

export interface FulfilmentJob {
  id: string;
  transaction_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

export type JobOutcome = 'done' | 'retry' | 'needs_review';

// A transactions row, untyped like everywhere else that reads one (vendInputFromRow and
// reconcileStuckRow take the same shape).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxRow = Record<string, any>;

const FINISHED = new Set(['SUCCESS', 'FAILED_VENDING', 'REFUNDED', 'EXPIRED', 'FAILED_PAYMENT', 'REVERSED_NEEDS_REFUND']);

export function backoffSeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

async function exchangeRate(): Promise<number> {
  const { data } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).maybeSingle();
  return Number((data as { exchange_rate?: number } | null)?.exchange_rate) || 1500;
}

/**
 * Does the provider already have this order? Read-only (VTpass /requery, Monnify transfer
 * status). Any doubt, including the provider being unreachable, answers TRUE, which sends the
 * row down the requery path: never re-send when unsure.
 */
async function providerKnows(tx: TxRow): Promise<boolean> {
  if (!tx.request_id) return true; // nothing to look up; let the reconciler alert as it always has
  try {
    if (tx.service_category === 'BANK') {
      return (await requeryMonnifyTransfer(tx.request_id)) != null;
    }
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
    const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
    const res = await fetch(`${baseUrl}/requery`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ request_id: tx.request_id }), signal: AbortSignal.timeout(15_000) });
    const data = await res.json();
    // Same test reconcileStuck uses for "VTpass has no record of this request_id".
    return !!(data?.content || data?.response_description);
  } catch {
    return true;
  }
}

/** Decide and do the work for one job. Never throws for a business outcome. */
export async function runFulfilmentJob(job: FulfilmentJob): Promise<{ outcome: JobOutcome; detail: string }> {
  const { data: row, error } = await supabase.from('transactions').select('*').eq('id', job.transaction_id).maybeSingle();
  if (error) return { outcome: 'retry', detail: `load failed: ${error.message}` };
  const tx = row as TxRow | null;
  if (!tx) return { outcome: 'done', detail: 'transaction no longer exists' };
  if (String(tx.tx_hash || '').startsWith('preflight_')) return { outcome: 'done', detail: 'not a proven payment' };
  if (FINISHED.has(tx.status)) return { outcome: 'done', detail: `already ${tx.status}` };
  if (tx.error_code === 'STUCK_ALERTED') return { outcome: 'needs_review', detail: 'an operator was already alerted about this payment' };

  if (tx.status === 'PROCESSING' && !tx.vend_dispatched_at && !(await providerKnows(tx))) {
    // Proven, claimed, never sent to the provider: the request died before it got that far.
    // providerKnows() is the belt to the dispatch stamp's braces: a row sent by code that
    // predates the stamp (or whose stamp write failed) is found at the provider and goes to
    // the requery path below instead of being sent a second time.
    const result = await executeVend(vendInputFromRow(tx, {
      txHash: tx.tx_hash,
      explorerUrl: `${explorerBaseFor(tx.blockchain)}/tx/${tx.tx_hash}`,
      baseRate: await exchangeRate(),
    }));
    if (result.status === 'SUCCESS' || result.status === 'FAILED_VENDING') return { outcome: 'done', detail: `delivered by the worker: ${result.status}` };
    return { outcome: 'retry', detail: `sent to the provider, outcome ${result.status || 'unknown'}; will requery` };
  }

  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
  const r = await reconcileStuckRow(tx, baseUrl);
  if (r === 'reconciled' || r === 'resolved_elsewhere') return { outcome: 'done', detail: `reconciled: ${r}` };
  if (r === 'alerted' || r === 'skipped') return { outcome: 'needs_review', detail: 'the provider has no clear answer; an operator was alerted' };
  return { outcome: 'retry', detail: 'still processing at the provider' };
}

/** Claim up to `limit` due jobs and run them, within a time budget. */
export async function runDueJobs(opts: { limit?: number; budgetMs?: number } = {}): Promise<{ ok: boolean; claimed: number; done: number; retried: number; review: number; error?: string }> {
  const limit = opts.limit ?? Math.max(1, Math.min(50, Number(process.env.JOBS_BATCH_SIZE) || 10));
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);

  const { data, error } = await supabase.rpc('claim_jobs', { p_limit: limit });
  if (error) {
    log.error('jobs.claim_failed', { error: error.message });
    return { ok: false, claimed: 0, done: 0, retried: 0, review: 0, error: error.message };
  }
  const jobs = (Array.isArray(data) ? data : []) as FulfilmentJob[];
  let done = 0, retried = 0, review = 0;

  for (const job of jobs) {
    if (Date.now() > deadline) {
      // Out of time: hand it back for the next run rather than leave it locked for 10 minutes.
      await supabase.rpc('fail_job', { p_id: job.id, p_error: 'worker time budget exhausted', p_retry_seconds: 5 });
      retried++;
      continue;
    }
    let outcome: JobOutcome;
    let detail: string;
    try {
      ({ outcome, detail } = await runFulfilmentJob(job));
    } catch (err) {
      outcome = 'retry';
      detail = err instanceof Error ? err.message : String(err);
    }

    if (outcome === 'done') {
      await supabase.rpc('complete_job', { p_id: job.id });
      done++;
    } else if (outcome === 'needs_review') {
      await supabase.from('fulfilment_jobs').update({ status: 'needs_review', locked_at: null, last_error: detail.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', job.id);
      review++;
    } else {
      const { data: status } = await supabase.rpc('fail_job', { p_id: job.id, p_error: detail, p_retry_seconds: backoffSeconds(job.attempts) });
      if (status === 'needs_review') {
        review++;
        await sendTelegramAlert(
          `🧾 *FULFILMENT JOB NEEDS REVIEW*\n\nTransaction \`${job.transaction_id}\` is still unresolved after ${job.attempts} attempts.\nLast: ${detail.slice(0, 200)}`,
          { key: `job-review-${job.id}` },
        ).catch(() => {});
      } else {
        retried++;
      }
    }
    metric('fulfilment_jobs_total', 1, { outcome });
    log.info('jobs.ran', { job_id: job.id, transaction_id: job.transaction_id, attempt: job.attempts, outcome, detail });
  }

  return { ok: true, claimed: jobs.length, done, retried, review };
}

/** Drop finished jobs after 30 days (needs_review rows are kept for the operator). From /api/cleanup. */
export async function pruneDoneJobs(days = 30): Promise<void> {
  try {
    await supabase.from('fulfilment_jobs').delete().eq('status', 'done').lt('updated_at', new Date(Date.now() - days * 86_400_000).toISOString());
  } catch (err) {
    log.warn('jobs.prune_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
