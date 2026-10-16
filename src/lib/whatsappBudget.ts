import { supabaseAdmin } from '@/utils/supabase';
import { rateLimit } from '@/lib/rateLimit';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ WHATSAPP COST CONTROLS.
//
// Since 1 October 2026 Meta bills every business reply ("service message") beyond 1,000 per
// month per phone number, and every template from the first one. Every bot reply is a service
// message, so a handful of chatty users could run up a bill their payments don't cover. Two
// controls keep that bounded:
//
//   1. A per-user daily cap on bot replies (WHATSAPP_DAILY_USER_CAP, default 20; tighter once the
//      month's free allowance is used up). Past it the user gets ONE message pointing them to
//      Telegram or the web app, which cost nothing, and then silence until midnight (Lagos), so
//      no further replies are billed. A payment already waiting for its PIN is never cut off.
//   2. A monthly count of everything we send, with a Telegram alert to the operator as it nears
//      and as it passes the free allowance, so a bill is never a surprise.
//
// Counters live in the shared rate_limits table (src/lib/rateLimit.ts), so they hold across
// serverless instances. Like the rate limiter, they fail open: a database hiccup must never
// silence the bot.

/** Meta's free service replies per number per month (since 1 October 2026). */
export const FREE_MONTHLY_REPLIES = Number(process.env.WHATSAPP_FREE_MONTHLY_REPLIES || 1000);
/** Bot replies one user gets per day while the month is inside the free allowance. */
export const DAILY_USER_CAP = Number(process.env.WHATSAPP_DAILY_USER_CAP || 20);
/** The cap once the free allowance is used up and every reply is billed. */
export const DAILY_USER_CAP_PAID = Number(process.env.WHATSAPP_DAILY_USER_CAP_PAID || 10);
/** Warn the operator when the month reaches this many replies. */
export const ALERT_AT = Number(process.env.WHATSAPP_MONTHLY_ALERT_AT || 800);

const TZ = 'Africa/Lagos';
const UNLIMITED = 1_000_000_000;
export const lagosDay = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
const monthKey = (now: Date) => `wa_month:${lagosDay(now).slice(0, 7)}`;

export const OVER_CAP_MESSAGE =
  "You've reached today's WhatsApp chat limit. To keep going right away, continue on Telegram (t.me/abapayagentbot) or pay at abapays.com, both free. WhatsApp chat resets at midnight.";

/**
 * Count one outbound WhatsApp message against the month. Alerts the operator once as the month
 * reaches ALERT_AT and once as it passes the free allowance. Returns the month's total.
 */
export async function countWhatsAppSend(now = new Date()): Promise<number> {
  const r = await rateLimit(monthKey(now), UNLIMITED, 40 * 86_400);
  const used = UNLIMITED - r.remaining;
  const month = lagosDay(now).slice(0, 7);
  if (used === ALERT_AT) {
    await sendTelegramAlert(`📊 *WhatsApp usage: ${used} replies this month (${month})*\nMeta's free allowance is ${FREE_MONTHLY_REPLIES}; after that every reply is billed. Per-user daily cap: ${DAILY_USER_CAP}.`).catch(() => {});
  } else if (used === FREE_MONTHLY_REPLIES + 1) {
    await sendTelegramAlert(`💸 *WhatsApp free allowance used up (${month})*\nEvery reply is now billed by Meta. The per-user daily cap is now ${DAILY_USER_CAP_PAID} until the month ends.`).catch(() => {});
  }
  return used;
}

/** Replies sent so far this month, read without counting one. 0 when unknown (fail open). */
export async function monthUsedSoFar(now = new Date()): Promise<number> {
  try {
    const { data } = await supabaseAdmin.from('rate_limits').select('count').eq('key', monthKey(now)).maybeSingle();
    return Number((data as { count?: number } | null)?.count) || 0;
  } catch {
    return 0;
  }
}

export type CapDecision = { allow: true } | { allow: false; notify: boolean };

/**
 * May the bot answer this user's message? Counts it against the user's day. `midPayment` (the
 * chat is waiting for a PIN) always passes, so a payment is never cut off halfway. Over the cap,
 * `notify` is true exactly once per day: one explanation, then silence (nothing billed).
 */
export async function checkDailyCap(sender: string, midPayment: boolean, now = new Date()): Promise<CapDecision> {
  if (midPayment) return { allow: true };
  const cap = (await monthUsedSoFar(now)) > FREE_MONTHLY_REPLIES ? DAILY_USER_CAP_PAID : DAILY_USER_CAP;
  const r = await rateLimit(`wa_user:${sender}:${lagosDay(now)}`, cap, 2 * 86_400);
  if (r.allowed) return { allow: true };
  const notice = await rateLimit(`wa_user_notice:${sender}:${lagosDay(now)}`, 1, 2 * 86_400);
  return { allow: false, notify: notice.allowed };
}
