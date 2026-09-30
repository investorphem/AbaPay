import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';

// ⚡ INBOUND WEBHOOK DE-DUPLICATION (migration 030).
//
// Messaging platforms redeliver a webhook they think failed, with the same message id. Claim
// the id before doing any work: the first delivery gets 'NEW', every redelivery gets
// 'DUPLICATE' and should be answered 200 with nothing done.
//
// If the table can't be reached the delivery is processed anyway ('UNTRACKED'): losing a
// user's message is worse than the rare duplicate, and the session claim in /api/deai/core
// still stops a duplicate payment on its own.
//
// If processing then fails, call releaseWebhookEvent so the platform's retry is let through
// instead of being swallowed as a duplicate of a message that was never handled.

export type WebhookClaim = 'NEW' | 'DUPLICATE' | 'UNTRACKED';

export async function claimWebhookEvent(source: string, externalId: string | number | null | undefined): Promise<WebhookClaim> {
  if (externalId === null || externalId === undefined || externalId === '') return 'UNTRACKED';
  try {
    const { error } = await supabaseAdmin.from('webhook_events').insert({ source, external_id: String(externalId) });
    if (!error) {
      // /api/cleanup only runs when called, so also prune opportunistically (~1 in 50 new
      // deliveries) to keep the table bounded. Awaited: Vercel may freeze after the response.
      if (Math.random() < 0.02) await pruneWebhookEvents();
      return 'NEW';
    }
    if (error.code === '23505') return 'DUPLICATE';
    console.error(`[WebhookEvents] claim failed (${source}):`, error.message);
    return 'UNTRACKED';
  } catch (err) {
    console.error(`[WebhookEvents] claim failed (${source}):`, err);
    return 'UNTRACKED';
  }
}

export async function releaseWebhookEvent(source: string, externalId: string | number | null | undefined): Promise<void> {
  if (externalId === null || externalId === undefined || externalId === '') return;
  try {
    await supabaseAdmin.from('webhook_events').delete().eq('source', source).eq('external_id', String(externalId));
  } catch { /* best-effort: worst case the retry is dropped as a duplicate */ }
}

/** Prune rows past every platform's retry window. Called from /api/cleanup. */
export async function pruneWebhookEvents(olderThanDays = 7): Promise<void> {
  try {
    await supabaseAdmin.from('webhook_events').delete().lt('received_at', new Date(Date.now() - olderThanDays * 86_400_000).toISOString());
  } catch (err) {
    console.error('[WebhookEvents] prune failed:', err);
  }
}
