import { NextResponse } from 'next/server';
import { parseIntent } from '@/lib/deai/intentEngine';
import { assessFeasibility, describeCapabilities, capabilityForIntent, getCapability } from '@/lib/deai/capabilities';
import { enforceRateLimit, enforceRateLimitByKey } from '@/lib/rateLimit';
import { resolveServiceId, fetchCryptoBalances } from '@/lib/deai/services';
import { getServiceRules } from '@/lib/serviceRules';
import { getRemainingAllowance } from '@/lib/deai/relayer';
import { humanizeReply } from '@/lib/deai/humanize';
import { supabaseAdmin } from '@/utils/supabase';
// Batch capacity/grouping now lives in a shared module so the social channels
// (/api/deai/core) run the exact same maths rather than a second, drifting copy.
import { checkAutonomousCapacity, groupByChainToken, type BatchItem } from '@/lib/deai/batch';

// ⚡ IN-APP AI CHAT
//
// The same Claude intent engine and the same feasibility rules the social bots use — but
// in the web app, where the user's wallet already is.
//
// TWO WAYS THIS RESPONDS NOW:
//   1. IMMEDIATE, single recipient — unchanged from before: returns a `prefill` object, the
//      user reviews it in the form and signs themselves. The chat never moves money here.
//   2. FUTURE ("in 10 minutes"), RECURRING ("every Tuesday"), or MULTI-RECIPIENT ("send to
//      X and Y") — none of these can be a single "sign now" transaction, so they go through
//      the SAME delegated on-chain allowance the Telegram/WhatsApp/X agent uses. This route
//      only ever PROPOSES it (`scheduleConfirm`, with an Approve button) after checking the
//      wallet's on-chain allowance and balance actually cover it — the real commit + a second,
//      server-side re-verification happens in POST /api/schedules, never here.

function serviceCategoryForIntent(intent: string): string {
  return intent === 'PAY_ELECTRICITY' ? 'ELECTRICITY'
    : intent === 'PAY_CABLE' ? 'CABLE'
    : intent === 'VEND_DATA' ? 'DATA'
    : 'AIRTIME';
}

// ScheduleItem/checkAutonomousCapacity/groupByChainToken moved to @/lib/deai/batch so
// /api/deai/core (the social channels) uses the identical implementation.
type ScheduleItem = BatchItem;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return `${n}st`;
  if (n % 10 === 2 && n % 100 !== 12) return `${n}nd`;
  if (n % 10 === 3 && n % 100 !== 13) return `${n}rd`;
  return `${n}th`;
}

export async function POST(req: Request) {
  const ctx: { lang?: string; userText?: string } = {};
  const res = await handleChat(req, ctx);
  // Localize the in-app reply into the user's language (non-English only) — same safe
  // humanizer the social channels use; it preserves every number/hash/link or falls back.
  if (ctx.lang && ctx.lang !== 'en') {
    try {
      const data = await res.clone().json();
      if (typeof data?.reply === 'string') {
        const localized = await humanizeReply(data.reply, { language: ctx.lang, channel: 'INAPP', userText: ctx.userText });
        if (localized && localized !== data.reply) return NextResponse.json({ ...data, reply: localized }, { status: res.status });
      }
    } catch { /* fall through to the original reply */ }
  }
  return res;
}

async function handleChat(req: Request, ctx: { lang?: string; userText?: string }): Promise<Response> {
  const limited = await enforceRateLimit(req, 'deai-chat', 20, 60);
  if (limited) return limited;

  // The chat is only reachable once a wallet is connected (gated client-side), so a
  // connected wallet spamming from rotating IPs/networks still hits its own cap.
  const walletAddr = req.headers.get('x-wallet-address') || '';
  if (walletAddr) {
    const walletLimited = await enforceRateLimitByKey(`deai-chat-wallet:${walletAddr.toLowerCase()}`, 20, 60);
    if (walletLimited) return walletLimited;
  }

  try {
    // Operator can disable the in-app assistant from the admin dashboard.
    const rules = await getServiceRules();
    if (!rules.aiChatEnabled) {
      return NextResponse.json({ success: false, reply: 'The assistant is temporarily unavailable. You can still pay using the form.' }, { status: 503 });
    }

    const body = await req.json();
    const { message } = body;

    // Chain/token the user currently has selected in the Pay tab — the frontend sends
    // whatever's active there. Only used for the schedule/batch paths below (checking an
    // on-chain allowance); the immediate "sign now" path is untouched by this.
    const chain = String(body.chain || 'CELO').toUpperCase() === 'BASE' ? 'BASE' : 'CELO';
    const tokenSymbol = typeof body.tokenSymbol === 'string' && body.tokenSymbol ? body.tokenSymbol : 'USD₮';

    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ success: false, reply: 'Say something and I\'ll help.' }, { status: 400 });
    }
    if (message.length > 500) {
      return NextResponse.json({ success: false, reply: 'That message is a bit long — can you shorten it?' }, { status: 400 });
    }

    const ai = await parseIntent(message);
    ctx.userText = message;
    if (ai?.language && ai.language !== 'en') ctx.lang = ai.language;

    // Help / capability menu
    if (ai.intent === 'HELP' || ai.intent === 'UNKNOWN') {
      const menu = await describeCapabilities();
      return NextResponse.json({
        success: true,
        reply: ai.intent === 'HELP' ? menu : `I didn't quite catch that.\n\n${menu}`,
      });
    }

    if (ai.intent === 'CHECK_BALANCE') {
      return NextResponse.json({ success: true, reply: 'Your balance is shown at the top of the page — tap the token selector to switch between USDT, USDC and cUSD.' });
    }
    if (ai.intent === 'TRANSACTION_HISTORY') {
      return NextResponse.json({ success: true, reply: 'Opening your history…', navigate: 'history' });
    }

    // ⚡ SCHEDULE MANAGEMENT — list or cancel existing automations (including ones created
    // from this very chat via scheduleConfirm below).
    if (ai.intent === 'LIST_SCHEDULES' || ai.intent === 'CANCEL_SCHEDULE') {
      if (!walletAddr) {
        return NextResponse.json({ success: true, reply: 'Connect your wallet first so I can look up your automations.' });
      }

      const { data } = await supabaseAdmin
        .from('scheduled_bills')
        .select('*')
        .ilike('wallet_address', walletAddr)
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      const schedules = data || [];

      if (ai.intent === 'LIST_SCHEDULES') {
        if (!schedules.length) {
          return NextResponse.json({ success: true, reply: 'You don\'t have any active automations. Try: "Every Tuesday buy ₦200 airtime for 08012345678".' });
        }
        const lines = schedules.map((s: any) => {
          const when = s.frequency === 'once' ? `once, at ${new Date(s.run_once_at).toLocaleString()}`
            : s.frequency === 'weekly' ? `every ${WEEKDAY_SHORT[Number(s.day_of_week)] || '?'}`
            : s.frequency === 'daily' ? 'daily'
            : `on the ${ordinal(Number(s.day_of_month))} of every month`;
          return `• ${s.provider || ''} ${s.service_category} — ₦${Number(s.amount_ngn).toLocaleString()} (${when})${s.auto_execute ? ' 🤖 auto' : ''}`;
        });
        return NextResponse.json({ success: true, reply: `*Your automations:*\n\n${lines.join('\n')}` });
      }

      // CANCEL_SCHEDULE
      if (!schedules.length) {
        return NextResponse.json({ success: true, reply: "You don't have any active automations to cancel." });
      }
      let match = schedules;
      if (ai.provider) {
        const byProvider = schedules.filter((s: any) => String(s.provider || '').toUpperCase() === ai.provider);
        if (byProvider.length) match = byProvider;
      }
      if (match.length === 1) {
        await supabaseAdmin.from('scheduled_bills').update({ is_active: false }).eq('id', match[0].id);
        return NextResponse.json({ success: true, reply: `✅ Cancelled your ${match[0].provider || ''} ${match[0].service_category} automation.` });
      }
      const list = schedules.map((s: any, i: number) => `${i + 1}. ${s.provider || ''} ${s.service_category} — ₦${Number(s.amount_ngn).toLocaleString()}`).join('\n');
      return NextResponse.json({ success: true, reply: `You have a few automations — which one? Name the provider, e.g. "cancel my MTN airtime automation":\n\n${list}` });
    }

    const isForeign = !!(ai.country && ai.country !== 'NG');
    const effectiveIntent = isForeign ? 'INTERNATIONAL' : ai.intent;

    // ⚡ MULTI-RECIPIENT BATCH — "send 500 to X on Celo with USDC and 1000 to Y on Base with
    // USDT". Each recipient can name its OWN chain/token (falls back to whatever's currently
    // selected in the app); the batch groups by (chain, token) and checks the allowance and
    // balance for EACH group's own subtotal — a Celo/USDC shortfall doesn't block a Base/USDT
    // group that's perfectly fine. All-or-nothing across the whole batch: if any recipient or
    // any group comes up short, nothing is proposed until it's fixed.
    if (ai.recipients && ai.recipients.length >= 2) {
      if (!walletAddr) {
        return NextResponse.json({ success: true, reply: 'Connect your wallet first — sending to multiple people needs an approved agent limit.' });
      }
      if (effectiveIntent !== 'VEND_AIRTIME' && effectiveIntent !== 'VEND_DATA') {
        return NextResponse.json({ success: true, reply: 'Multiple recipients in one message is only supported for airtime and data right now — please send other bills one at a time.' });
      }

      const items: ScheduleItem[] = [];
      for (const rec of ai.recipients) {
        const feas = await assessFeasibility({
          intent: effectiveIntent, provider: rec.provider, amountNgn: rec.amount_ngn, account: rec.destination_account,
        });
        if (!feas.possible || feas.missing.length) {
          return NextResponse.json({
            success: true,
            reply: `I can't complete this batch — one recipient (${rec.destination_account || 'unknown number'}) has an issue: ${feas.reason || 'missing details'}. Please fix that one and resend the whole list.`,
          });
        }
        items.push({
          serviceCategory: serviceCategoryForIntent(effectiveIntent),
          serviceID: resolveServiceId(effectiveIntent, rec.provider) || rec.provider || '',
          provider: rec.provider,
          billersCode: rec.destination_account as string,
          amountNgn: rec.amount_ngn as number,
          chain: rec.chain || chain,
          tokenSymbol: rec.token || tokenSymbol,
        });
      }

      const groups = groupByChainToken(items);
      const groupSummaries: string[] = [];
      for (const [key, groupItems] of groups) {
        const [groupChain, groupToken] = key.split('|');
        const groupTotal = groupItems.reduce((s, it) => s + it.amountNgn, 0);
        const capacity = await checkAutonomousCapacity(walletAddr, groupChain, groupToken, groupTotal, rules.exchangeRate);
        if (!capacity.ok) {
          return NextResponse.json({ success: true, reply: `${groupItems.length} of these ${groupItems.length === 1 ? 'is' : 'are'} on ${groupToken}/${groupChain}: ${capacity.reason}` });
        }
        groupSummaries.push(`• ${groupToken} on ${groupChain}: ${groupItems.length} payment${groupItems.length === 1 ? '' : 's'}, ₦${groupTotal.toLocaleString()} (${capacity.neededCrypto.toFixed(4)} ${groupToken}) — approved ${capacity.allowanceRemaining.toFixed(2)}, balance ${capacity.balance.toFixed(2)}`);
      }

      const totalNgn = items.reduce((s, it) => s + it.amountNgn, 0);

      return NextResponse.json({
        success: true,
        reply: `Got it — ${items.length} payments totalling ₦${totalNgn.toLocaleString()}:\n\n${groupSummaries.join('\n')}\n\nTap Approve to send all ${items.length} now.`,
        scheduleConfirm: {
          items,
          runOnceInMinutes: 1, // fires on the very next instant-cron tick — as close to "now" as this mechanism gets
          totalNgn,
        },
      });
    }

    // ⚡ ONE-OFF FUTURE ("in 10 minutes") OR RECURRING ("every Tuesday") — single recipient.
    if (ai.schedule_in_minutes || ai.is_recurring) {
      if (!walletAddr) {
        return NextResponse.json({ success: true, reply: 'Connect your wallet first — scheduling a payment needs an approved agent limit.' });
      }

      const f = await assessFeasibility({
        intent: effectiveIntent, provider: ai.provider, amountNgn: ai.amount_ngn,
        account: ai.destination_account, meterType: ai.meter_type, country: ai.country,
      });

      if (!f.possible || f.needsApp || f.missing.length) {
        const extra = f.needsApp ? ' Scheduling isn\'t available for this yet — please handle it in the app when it\'s due.' : '';
        return NextResponse.json({
          success: true,
          reply: [f.reason + extra, ...(f.suggestions.length ? ['', ...f.suggestions.map(s => `• ${s}`)] : [])].join('\n'),
        });
      }

      const itemChain = ai.chain || chain;
      const itemToken = ai.token || tokenSymbol;

      const item: ScheduleItem = {
        serviceCategory: serviceCategoryForIntent(effectiveIntent),
        serviceID: resolveServiceId(effectiveIntent, ai.provider) || ai.provider || '',
        provider: ai.provider,
        billersCode: ai.destination_account as string,
        amountNgn: ai.amount_ngn as number,
        meterType: ai.meter_type || undefined,
        chain: itemChain,
        tokenSymbol: itemToken,
      };

      const capacity = await checkAutonomousCapacity(walletAddr, itemChain, itemToken, item.amountNgn, rules.exchangeRate);
      if (!capacity.ok) {
        return NextResponse.json({
          success: true,
          reply: ai.schedule_in_minutes ? `${capacity.reason}\n\nOr just come back and pay it in the form when it's due.` : capacity.reason,
        });
      }

      const when = ai.schedule_in_minutes
        ? `in ${ai.schedule_in_minutes} minute${ai.schedule_in_minutes === 1 ? '' : 's'}`
        : ai.frequency === 'weekly' ? `every ${WEEKDAY_NAMES[ai.day_of_week ?? 0]}`
        : ai.frequency === 'daily' ? 'every day'
        : `on the ${ordinal(Number(ai.day_of_month))} of every month`;

      return NextResponse.json({
        success: true,
        reply: `Got it — ${item.provider || ''} ${item.serviceCategory.toLowerCase()} for ₦${item.amountNgn.toLocaleString()}, ${when} (${capacity.neededCrypto.toFixed(4)} ${itemToken} on ${itemChain}).\n\nYou have ${capacity.allowanceRemaining.toFixed(2)} ${itemToken} approved and ${capacity.balance.toFixed(2)} ${itemToken} in your wallet.\n\nTap Approve to confirm.`,
        scheduleConfirm: {
          items: [item],
          runOnceInMinutes: ai.schedule_in_minutes || undefined,
          recurring: ai.is_recurring ? { frequency: ai.frequency, dayOfWeek: ai.day_of_week, dayOfMonth: ai.day_of_month } : undefined,
          totalNgn: item.amountNgn,
        },
      });
    }

    const f = await assessFeasibility({
      intent: effectiveIntent,
      provider: ai.provider,
      amountNgn: ai.amount_ngn,
      account: ai.destination_account,
      meterType: ai.meter_type,
      country: ai.country,
    });

    // Not possible (kill switch, below min, unsupported country) — explain + suggest.
    if (!f.possible) {
      return NextResponse.json({
        success: true,
        reply: [f.reason, ...(f.suggestions.length ? ['', ...f.suggestions.map(s => `• ${s}`)] : [])].join('\n'),
      });
    }

    // Belongs in a different part of the app (bank, education).
    if (f.needsApp) {
      const spec = getCapability(capabilityForIntent(effectiveIntent)!);
      return NextResponse.json({
        success: true,
        reply: `${spec?.label}: ${f.reason}`,
        navigate: effectiveIntent === 'BANK_TRANSFER' ? 'bank' : effectiveIntent === 'EDUCATION' ? 'education' : undefined,
      });
    }

    // Still missing details — ask for them conversationally.
    if (f.missing.length) {
      return NextResponse.json({
        success: true,
        reply: [f.reason, ...(f.suggestions.length ? ['', ...f.suggestions.map(s => `• ${s}`)] : [])].join('\n'),
      });
    }

    // ✅ Everything we need — hand back a PREFILL. The user still signs.
    const serviceCategory = serviceCategoryForIntent(ai.intent);

    return NextResponse.json({
      success: true,
      reply: `Got it — I've filled in your ${ai.provider || ''} ${serviceCategory.toLowerCase()} payment of ₦${Number(ai.amount_ngn).toLocaleString()}. Review it and tap Pay.`,
      prefill: {
        serviceCategory,
        serviceID: resolveServiceId(ai.intent, ai.provider) || ai.provider,
        provider: ai.provider,
        billersCode: ai.destination_account,
        amountNgn: ai.amount_ngn,
        meterType: ai.meter_type,
      },
    });
  } catch (err) {
    console.error('[DeAI Chat] error:', err);
    return NextResponse.json({ success: false, reply: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
