import { NextResponse } from 'next/server';
import { parseIntent } from '@/lib/deai/intentEngine';
import { assessFeasibility, describeCapabilities, capabilityForIntent, getCapability } from '@/lib/deai/capabilities';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveServiceId } from '@/lib/deai/services';
import { getServiceRules } from '@/lib/serviceRules';

// ⚡ IN-APP AI CHAT
//
// The same Claude intent engine and the same feasibility rules the social bots use — but
// in the web app, where the user's wallet already is.
//
// KEY DIFFERENCE FROM THE BOTS: there is NO PIN and NO relayer here. The user is already
// holding their wallet, so the chat's job is simply to UNDERSTAND the request and PRE-FILL
// the payment form. The user then signs, exactly as they always have. The chat can never
// move money on its own — it returns a `prefill` object, nothing more.

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'deai-chat', 20, 60);
  if (limited) return limited;

  try {
    // Operator can disable the in-app assistant from the admin dashboard.
    const rules = await getServiceRules();
    if (!rules.aiChatEnabled) {
      return NextResponse.json({ success: false, reply: 'The assistant is temporarily unavailable. You can still pay using the form.' }, { status: 503 });
    }

    const { message } = await req.json();

    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ success: false, reply: 'Say something and I\'ll help.' }, { status: 400 });
    }
    if (message.length > 500) {
      return NextResponse.json({ success: false, reply: 'That message is a bit long — can you shorten it?' }, { status: 400 });
    }

    const ai = await parseIntent(message);

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

    const isForeign = !!(ai.country && ai.country !== 'NG');
    const effectiveIntent = isForeign ? 'INTERNATIONAL' : ai.intent;

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
    const serviceCategory =
      ai.intent === 'PAY_ELECTRICITY' ? 'ELECTRICITY' :
      ai.intent === 'PAY_CABLE' ? 'CABLE' :
      ai.intent === 'VEND_DATA' ? 'DATA' : 'AIRTIME';

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
      // Recurrence, if they asked for it.
      schedule: ai.is_recurring ? {
        frequency: ai.frequency,
        dayOfWeek: ai.day_of_week,
        dayOfMonth: ai.day_of_month,
      } : undefined,
    });
  } catch (err) {
    console.error('[DeAI Chat] error:', err);
    return NextResponse.json({ success: false, reply: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
