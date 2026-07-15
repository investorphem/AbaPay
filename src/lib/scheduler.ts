import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { fetchCryptoBalances } from '@/lib/deai/services';
import { createDeepLink } from '@/lib/deai/deeplink';
import { relayPayBillFor, getRemainingAllowance } from '@/lib/deai/relayer';
import { checkServiceAllowed, getServiceRules, checkAgentSpendAllowed } from '@/lib/serviceRules';
import { sendTelegramToUser } from '@/lib/telegram';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// ⚡ AUTONOMOUS BILL AGENT
//
// "Every Tuesday, buy ₦200 airtime for my MTN line."  →  it just happens.
//
// WHY THIS IS SAFE (and why it was impossible before AbaPayV3):
// The user grants an ON-CHAIN spending allowance from their own wallet. The CONTRACT
// enforces the cap — not this code, not our database. Autonomous execution therefore can
// never spend more than the number the user personally signed for, no matter what goes
// wrong here. Revocation is instant and unilateral: setSpendingAllowance(token, 0).
//
// Guardrails layered on top:
//   • auto_execute is OPT-IN per schedule (defaults to false → notify-only)
//   • kill switches are re-checked before every execution, so an operator can halt a broken
//     service and autonomous payments stop with it
//   • one run per schedule per day (last_run_date) — a misfiring cron cannot double-charge
//   • 3 consecutive failures auto-pauses the schedule and tells the user

const WARN_DAYS_AHEAD = 3;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface ScheduleRunResult {
  checked: number;
  paid: number;
  warned: number;
  notified: number;
  skipped: number;
  errors: number;
}

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com';
}

function isDueToday(bill: any, now: Date): boolean {
  const freq = (bill.frequency || 'monthly').toLowerCase();
  if (freq === 'daily') return true;
  if (freq === 'weekly') return Number(bill.day_of_week) === now.getUTCDay();
  return Number(bill.day_of_month) === now.getUTCDate();
}

// Early shortfall warnings only make sense for monthly schedules; weekly/daily are too near.
function isApproaching(bill: any, now: Date): boolean {
  const freq = (bill.frequency || 'monthly').toLowerCase();
  if (freq !== 'monthly' || !bill.day_of_month) return false;
  for (let i = 1; i <= WARN_DAYS_AHEAD; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + i);
    if (d.getUTCDate() === Number(bill.day_of_month)) return true;
  }
  return false;
}

async function notify(bill: any, message: string, payUrl?: string) {
  if (bill.notify_telegram) {
    try { await sendTelegramToUser(bill.notify_telegram, message); } catch (e) { console.error('[Scheduler] telegram failed', e); }
  }
  if (bill.notify_email) {
    try {
      await resend.emails.send({
        from: 'AbaPay <receipts@abapays.com>',
        to: bill.notify_email,
        replyTo: 'support@abapays.com',
        subject: 'AbaPay — scheduled bill update',
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;">
          <p style="color:#334155;white-space:pre-line;">${message.replace(/\*/g, '')}</p>
          ${payUrl ? `<p style="margin-top:20px;"><a href="${payUrl}" style="background:#10b981;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Approve &amp; Pay</a></p>` : ''}
          <p style="font-size:12px;color:#94a3b8;margin-top:24px;">Your funds stay in your wallet — AbaPay never holds them.</p>
        </div>`,
      });
    } catch (e) { console.error('[Scheduler] email failed', e); }
  }
}

export async function runScheduledBills(): Promise<ScheduleRunResult> {
  const r: ScheduleRunResult = { checked: 0, paid: 0, warned: 0, notified: 0, skipped: 0, errors: 0 };

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const { data: bills, error } = await supabaseAdmin
    .from('scheduled_bills')
    .select('*')
    .eq('is_active', true);

  if (error) {
    console.error('[Scheduler] load failed:', error.message);
    return { ...r, errors: 1 };
  }
  if (!bills || bills.length === 0) return r;

  const rules = await getServiceRules();

  for (const bill of bills as any[]) {
    r.checked++;
    try {
      // Idempotence: at most one run per schedule per day. A double-firing cron cannot double-charge.
      if (bill.last_run_date === today) { r.skipped++; continue; }

      const due = isDueToday(bill, now);
      const approaching = isApproaching(bill, now);
      if (!due && !approaching) { r.skipped++; continue; }

      const label = `${bill.provider || ''} ${bill.service_category}`.trim();
      const amountNgn = Number(bill.amount_ngn);
      const amountLabel = `₦${amountNgn.toLocaleString()}`;
      const token = bill.token_used || 'USD₮';
      const chain = bill.blockchain || 'CELO';

      // 🔴 RULE GATE: an operator-disabled service must halt autonomous payments too.
      const intentKey =
        bill.service_category === 'ELECTRICITY' ? 'ELECTRICITY' :
        bill.service_category === 'CABLE' ? 'TV' :
        bill.service_category === 'DATA' ? 'VEND_DATA' : 'VEND_AIRTIME';

      const gate = await checkServiceAllowed(intentKey);
      if (!gate.allowed) {
        if (due) {
          await notify(bill, `⛔ *${label} — ${amountLabel}*\n\nYour scheduled payment was NOT made: ${gate.reason}\n\nWe'll retry on your next scheduled date.`);
          await supabaseAdmin.from('scheduled_bills').update({ last_run_date: today }).eq('id', bill.id);
          r.notified++;
        }
        continue;
      }

      const needed = amountNgn / rules.exchangeRate;

      // ── AUTONOMOUS EXECUTION ─────────────────────────────────────────────
      if (due && bill.auto_execute) {
        // ⚡ OPERATOR GATE — an operator can pause autonomous payments alone (leaving
        // PIN-confirmed chat payments working), or halt the agent entirely.
        const opGate = await checkAgentSpendAllowed(supabaseAdmin, bill.wallet_address, amountNgn, { autonomous: true });
        if (!opGate.allowed) {
          await notify(bill, `⚠️ *${label} — ${amountLabel}*\n\n${opGate.reason}`);
          await supabaseAdmin.from('scheduled_bills').update({ last_run_date: today }).eq('id', bill.id);
          r.notified++;
          continue;
        }

        const allowance = await getRemainingAllowance(bill.wallet_address, token, chain);

        if (!allowance.ok || allowance.remaining < needed) {
          await notify(
            bill,
            `⚠️ *Couldn't auto-pay your ${label} bill (${amountLabel}).*\n\nYour approved agent limit is ${allowance.remaining.toFixed(2)} ${token} — this needs about ${needed.toFixed(2)}.\n\nRaise your limit in the AbaPay app and I'll get it next time.`
          );
          await supabaseAdmin.from('scheduled_bills').update({ last_run_date: today }).eq('id', bill.id);
          r.notified++;
          continue;
        }

        const res = await relayPayBillFor({
          userWallet: bill.wallet_address,
          tokenSymbol: token,
          serviceType: bill.service_id,
          accountNumber: bill.billers_code,
          amountCrypto: needed.toFixed(6),
          blockchain: chain,
          sourceChannel: 'SCHEDULE',        // unattended — highest-scrutiny alert
          amountNgn,
        });

        if (res.success) {
          await supabaseAdmin.from('scheduled_bills').update({
            last_run_date: today,
            last_paid_at: new Date().toISOString(),
            last_tx_hash: res.txHash,
            consecutive_failures: 0,
          }).eq('id', bill.id);

          const left = (allowance.remaining - needed).toFixed(2);
          await notify(
            bill,
            `✅ *Paid automatically — ${label}*\n\n${amountLabel} (${needed.toFixed(4)} ${token})\n📱 ${bill.billers_code}\n🔗 \`${res.txHash}\`\n\n💳 Remaining agent limit: *${left} ${token}*`
          );
          r.paid++;
          continue;
        }

        // Failed — count it, and pause the schedule if it keeps failing.
        const fails = Number(bill.consecutive_failures || 0) + 1;
        const shouldPause = fails >= MAX_CONSECUTIVE_FAILURES;

        await supabaseAdmin.from('scheduled_bills').update({
          last_run_date: today,
          consecutive_failures: fails,
          is_active: !shouldPause,
        }).eq('id', bill.id);

        await notify(
          bill,
          shouldPause
            ? `🛑 *${label} schedule paused.*\n\nIt failed ${fails} times in a row: ${res.message}\n\nFix the issue and re-enable it in the AbaPay app.`
            : `⚠️ *Couldn't auto-pay your ${label} bill (${amountLabel}).*\n\n${res.message}\n\nI'll try again on your next scheduled date.`
        );
        r.errors++;
        continue;
      }

      // ── NOTIFY-ONLY (auto_execute off, or an early shortfall warning) ────
      const balances = await fetchCryptoBalances(bill.wallet_address, chain);
      const held = Number(balances[token] ?? 0);
      const short = held < needed;

      let message: string | null = null;
      let payUrl: string | undefined;

      if (due) {
        payUrl = createDeepLink(baseUrl(), {
          serviceID: bill.service_id,
          serviceCategory: bill.service_category,
          provider: bill.provider || '',
          billersCode: bill.billers_code,
          amountNgn,
          variationCode: bill.variation_code || undefined,
          meterType: bill.meter_type || undefined,
          customerName: bill.customer_name || undefined,
          customerAddress: bill.customer_address || undefined,
          chain: chain as 'CELO' | 'BASE',
          token,
          channel: 'SCHEDULE',
          chatId: bill.notify_telegram || '',
        });

        message = short
          ? `⚠️ *${label} due today — ${amountLabel}*\n\nYour ${token} balance (${held.toFixed(2)}) won't cover it — you need about ${needed.toFixed(2)}. Top up, then tap:\n${payUrl}`
          : `🔔 *${label} due today — ${amountLabel}*\n\nTap to approve:\n${payUrl}`;
      } else if (approaching && short) {
        // The churn-killer: warn BEFORE they miss it.
        const daysAway = (Number(bill.day_of_month) - now.getUTCDate() + 31) % 31;
        message = `⚠️ *Heads up — your ${label} bill (${amountLabel}) is due in ${daysAway} day${daysAway === 1 ? '' : 's'}.*\n\nYour ${token} balance is ${held.toFixed(2)}; you'll need about ${needed.toFixed(2)}. Top up so you don't miss it.`;
        r.warned++;
      }

      if (!message) { r.skipped++; continue; }

      await notify(bill, message, payUrl);
      await supabaseAdmin.from('scheduled_bills')
        .update({ last_notified_at: new Date().toISOString(), ...(due ? { last_run_date: today } : {}) })
        .eq('id', bill.id);
      r.notified++;
    } catch (err) {
      console.error('[Scheduler] bill failed:', err);
      r.errors++;
    }
  }

  return r;
}
