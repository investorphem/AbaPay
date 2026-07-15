import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';

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
    if (!b.service_id || !b.billers_code || !b.amount_ngn || !b.day_of_month) {
      return NextResponse.json({ success: false, message: 'Missing required fields' }, { status: 400 });
    }

    const day = Number(b.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return NextResponse.json({ success: false, message: 'Day must be between 1 and 28 (so it exists in every month).' }, { status: 400 });
    }
    const amount = Number(b.amount_ngn);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid amount' }, { status: 400 });
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
        blockchain: b.blockchain || 'CELO',
        token_used: b.token_used || 'USD₮',
        day_of_month: day,
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
