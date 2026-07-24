import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';

// ⚡ ADMIN: discount/promo campaigns — create, edit, activate/deactivate, and monitor how much
// has actually been given away. Enforcement lives in src/lib/discounts.ts (checked fresh inside
// /api/pay/route.ts), so a change here is live for the next transaction — no redeploy.

export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: auth.message }, { status: 401 });

  const { data: campaigns, error } = await supabaseAdmin
    .from('discount_campaigns')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, message: 'Could not load campaigns.' }, { status: 500 });
  }

  // Monitoring: how much has actually been discounted, and by which campaign.
  const { data: discounted } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn, discount_campaign_id, status')
    .gt('discount_ngn', 0);

  const rows = discounted || [];
  const successfulRows = rows.filter((r: any) => r.status === 'SUCCESS');
  const byCampaign: Record<string, { discountNgn: number; count: number }> = {};
  for (const r of successfulRows) {
    const key = r.discount_campaign_id || 'unknown';
    if (!byCampaign[key]) byCampaign[key] = { discountNgn: 0, count: 0 };
    byCampaign[key].discountNgn += Number(r.discount_ngn || 0);
    byCampaign[key].count += 1;
  }

  return NextResponse.json({
    success: true,
    campaigns: campaigns || [],
    stats: {
      totalDiscountNgn: successfulRows.reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0),
      discountedTxCount: successfulRows.length,
      byCampaign,
    },
  });
}

export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: auth.message }, { status: 401 });

  try {
    const body = await req.json();
    const { id, name, type, value, max_discount_ngn, services, starts_at, ends_at, is_active } = body;

    const cleanServices = Array.isArray(services) && services.length > 0 ? services : null;

    if (id) {
      // Partial update — only the provided fields change (mirrors /api/admin/agent's pattern).
      const update: Record<string, any> = { updated_at: new Date().toISOString() };
      if (name !== undefined) update.name = String(name);
      if (type !== undefined) {
        if (!['PERCENT', 'FIXED'].includes(type)) return NextResponse.json({ success: false, message: 'type must be PERCENT or FIXED' }, { status: 400 });
        update.type = type;
      }
      if (value !== undefined) {
        const v = Number(value);
        if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ success: false, message: 'Invalid value' }, { status: 400 });
        update.value = v;
      }
      if (max_discount_ngn !== undefined) update.max_discount_ngn = max_discount_ngn === null || max_discount_ngn === '' ? null : Number(max_discount_ngn);
      if (services !== undefined) update.services = cleanServices;
      if (starts_at !== undefined) update.starts_at = starts_at || null;
      if (ends_at !== undefined) update.ends_at = ends_at || null;
      if (typeof is_active === 'boolean') update.is_active = is_active;

      const { error } = await supabaseAdmin.from('discount_campaigns').update(update).eq('id', id);
      if (error) return NextResponse.json({ success: false, message: 'Could not save campaign.' }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    // Create
    if (!name || !type || value === undefined) {
      return NextResponse.json({ success: false, message: 'name, type, and value are required' }, { status: 400 });
    }
    if (!['PERCENT', 'FIXED'].includes(type)) {
      return NextResponse.json({ success: false, message: 'type must be PERCENT or FIXED' }, { status: 400 });
    }
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ success: false, message: 'Invalid value' }, { status: 400 });
    if (type === 'PERCENT' && v > 100) return NextResponse.json({ success: false, message: 'Percent discount cannot exceed 100' }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from('discount_campaigns')
      .insert({
        name: String(name),
        type,
        value: v,
        max_discount_ngn: max_discount_ngn === undefined || max_discount_ngn === null || max_discount_ngn === '' ? null : Number(max_discount_ngn),
        services: cleanServices,
        starts_at: starts_at || null,
        ends_at: ends_at || null,
        is_active: is_active !== false,
        created_by: auth.address,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ success: false, message: 'Could not create campaign.' }, { status: 500 });
    return NextResponse.json({ success: true, campaign: data });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: auth.message }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, message: 'Missing id' }, { status: 400 });

  const { error } = await supabaseAdmin.from('discount_campaigns').delete().eq('id', id);
  if (error) return NextResponse.json({ success: false, message: 'Could not delete campaign.' }, { status: 500 });
  return NextResponse.json({ success: true });
}
