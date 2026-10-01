import { log } from '@/lib/log';

// ⏰ DEAD-MAN SWITCHES FOR THE CRONS (M5).
//
// Nothing used to notice a cron that STOPPED running: the external scheduler could be paused,
// lose its secret, or hit a deploy that 404s the route, and the only symptom was refunds, one-off
// schedules or dashboards quietly going stale. Each cron now pings an external monitor
// (healthchecks.io or Better Stack heartbeats) when it finishes; the monitor pages when a ping
// is LATE. That is the point: an alert that needs the job to run can't report the job not running.
//
//   HEALTHCHECK_URL_CLEANUP     /api/cleanup
//   HEALTHCHECK_URL_SCHEDULES   /api/schedules/run
//   HEALTHCHECK_URL_INSTANT     /api/schedules/run-instant
//   HEALTHCHECK_URL_DUNE        /api/cron/dune-refresh (or HEALTHCHECK_URL_DUNE_<DASHBOARD>)
//
// A run that finished but FAILED pings `<url>/fail`, which both providers treat as an explicit
// failure. With no URL configured nothing is sent. A ping never throws or delays the job's own
// response by more than the 5s timeout.

export async function pingDeadman(job: string, ok: boolean, fallbackJob?: string): Promise<void> {
  const url = process.env[`HEALTHCHECK_URL_${job}`] || (fallbackJob ? process.env[`HEALTHCHECK_URL_${fallbackJob}`] : undefined);
  if (!url) return;
  const target = ok ? url : `${url.replace(/\/$/, '')}/fail`;
  try {
    const res = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!res.ok) log.warn('deadman.ping_rejected', { job, status: res.status });
  } catch (err) {
    log.warn('deadman.ping_failed', { job, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Run a cron body and ping its monitor with the outcome (a thrown error pings /fail). */
export async function withDeadman<T>(job: string, isOk: (result: T) => boolean, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await pingDeadman(job, isOk(result));
    return result;
  } catch (err) {
    await pingDeadman(job, false);
    throw err;
  }
}
