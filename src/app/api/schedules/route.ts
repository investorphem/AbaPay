import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getRemainingAllowance } from '@/lib/deai/relayer';
import { getServiceRules } from '@/lib/serviceRules';

// ⚡ SCHEDULED BILLS — in-app CRUD (the "Bill Pay & Autopay Agent")
//
// Scoped by wallet address. A user can only see/modify schedules for the wallet they
// supply; there is no cross-wallet read.

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'schedules-read', 60, 60);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const wallet = (searchParams.get('wallet') || '').toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ success: false, message: 'Valid wallet address required' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('scheduled_bills')
    .select('*')
    .ilike('wallet_address', wallet)
    .order('day_of_month', { ascending: true });

  if (error) {
    console.error('[Schedules] read failed:', error.message);
    return NextResponse.json({ success: false, message: 'Could not load your schedules.' }, { status: 500 });
  }

  return NextResponse.json({ success: true, schedules: data || [] });
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'schedules-write', 20, 60);
  if (limited) return limited;

  try {
    const b = await req.json();
    const wallet = String(b.wallet_address || '').toLowerCase();

    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return NextResponse.json({ success: false, message: 'Valid wallet address required' }, { status: 400 });
    }
    if (!b.service_id || !b.billers_code || !b.amount_ngn) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400 });
    }

    const amount = Number(b.amount_ngn);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid amount' }, { status: 400 });
    }

    // ⚡ frequency now covers four shapes, not just "monthly": monthly (day_of_month),
    // weekly (day_of_week), daily (neither), and 'once' (run_once_at) — the one-off
    // "buy me airtime in the next 10 minutes" case from the DeAI chat.
    const frequency = ['monthly', 'weekly', 'daily', 'once'].includes(b.frequency) ? b.frequency : 'monthly';

    let day: number | null = null;
    let dayOfWeek: number | null = null;
    let runOnceAt: string | null = null;

    if (frequency === 'monthly') {
      day = Number(b.day_of_month);
      if (!Number.isInteger(day) || day < 1 || day > 28) {
        return NextResponse.json({ success: false, message: 'Day must be between 1 and 28 (so it exists in every month).' }, { status: 400 });
      }
    } else if (frequency === 'weekly') {
      dayOfWeek = Number(b.day_of_week);
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return NextResponse.json({ success: false, message: 'day_of_week must be 0 (Sunday) through 6 (Saturday).' }, { status: 400 });
      }
    } else if (frequency === 'once') {
      const parsed = new Date(b.run_once_at);
      if (!b.run_once_at || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        return NextResponse.json({ success: false, message: 'run_once_at must be a valid future timestamp.' }, { status: 400 });
      }
      // A one-off more than 7 days out isn't really a "in N minutes/hours" request anymore —
      // keep this endpoint scoped to what the instant runner is actually built to catch.
      if (parsed.getTime() > Date.now() + 7 * 24 * 60 * 60 * 1000) {
        return NextResponse.json({ success: false, message: 'One-off schedules can be at most 7 days out. For anything further, use a recurring schedule instead.' }, { status: 400 });
      }
      runOnceAt = parsed.toISOString();
    }

    const blockchain = (b.blockchain || 'CELO').toUpperCase();
    const tokenUsed = b.token_used || 'USD₮';
    const autoExecute = b.auto_execute === true;

    // ⚡ RE-VERIFY ON-CHAIN — never trust a client-supplied "yes I have an allowance for
    // this". Whatever the chat showed the user moments ago could be stale (another payment
    // landed, they revoked it, balance moved). Autonomous execution only ever gets created
    // if the allowance genuinely covers it RIGHT NOW; otherwise this becomes a notify-only
    // schedule instead of silently promising something the relayer will fail to honour later.
    let effectiveAutoExecute = false;
    if (autoExecute) {
      const rules = await getServiceRules();
      const needed = amount / rules.exchangeRate;
      const allowance = await getRemainingAllowance(wallet, tokenUsed, blockchain);
      if (allowance.ok && allowance.remaining >= needed) {
        effectiveAutoExecute = true;
      } else {
        return NextResponse.json({
          success: false,
          message: `Your approved agent limit for ${tokenUsed} on ${blockchain} is ${allowance.ok ? allowance.remaining.toFixed(2) : '0'} — this needs about ${needed.toFixed(2)}. Approve a higher limit in the Agent Hub tab, then try again.`,
        }, { status: 400 });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('scheduled_bills')
      .insert({
        wallet_address: wallet,
        service_id: b.service_id,
        service_category: b.service_category || 'ELECTRICITY',
        provider: b.provider || null,
        billers_code: b.billers_code,
        amount_ngn: amount,
        variation_code: b.variation_code || null,
        meter_type: b.meter_type || null,
        customer_name: b.customer_name || null,
        customer_address: b.customer_address || null,
        blockchain,
        token_used: tokenUsed,
        frequency,
        day_of_month: day,
        day_of_week: dayOfWeek,
        run_once_at: runOnceAt,
        batch_id: b.batch_id || null,
        auto_execute: effectiveAutoExecute,
        notify_email: b.notify_email || null,
        notify_telegram: b.notify_telegram || null,
      })
      .select()
      .single();

    if (error) {
      console.error('[Schedules] create failed:', error.message);
      return NextResponse.json({ success: false, message: 'Could not save that schedule.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, schedule: data });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const limited = await enforceRateLimit(req, 'schedules-write', 20, 60);
  if (limited) return limited;

  try {
    const { id, wallet_address } = await req.json();
    const wallet = String(wallet_address || '').toLowerCase();

    if (!id || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return NextResponse.json({ success: false, message: 'Schedule id and wallet required' }, { status: 400 });
    }

    // Scope the delete to the owning wallet — a user cannot delete someone else's schedule.
    const { error } = await supabaseAdmin
      .from('scheduled_bills')
      .delete()
      .eq('id', id)
      .ilike('wallet_address', wallet);

    if (error) {
      return NextResponse.json({ success: false, message: 'Could not delete that schedule.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
