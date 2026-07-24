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

  // ⚡ Master on/off switch for the whole suspicious-cluster feature — skip the query and the
  // panel entirely when disabled, not just hide it client-side.
  const { data: settingsRow } = await supabaseAdmin
    .from('platform_settings')
    .select('discount_fraud_flagging_enabled')
    .eq('id', 1)
    .single();
  const fraudFlaggingEnabled = settingsRow?.discount_fraud_flagging_enabled !== false;

  let suspiciousClusters: any[] = [];
  if (fraudFlaggingEnabled) {
    // ⚡ SUSPICIOUS CLUSTERS — one IP paying from several different wallets during an active
    // discount is the actual tell of wallet-farming (free wallets, but an IP is at least sticky
    // for a session). Flag-only: never auto-blocked, since shared mobile/NAT IPs among genuinely
    // unrelated users are common in Nigeria and would otherwise produce false positives.
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentDiscounted } = await supabaseAdmin
      .from('transactions')
      .select('client_ip, wallet_address, discount_ngn, discount_campaign_id, created_at')
      .gt('discount_ngn', 0)
      .eq('status', 'SUCCESS')
      .not('client_ip', 'is', null)
      .gte('created_at', sinceIso);

    const byIp: Record<string, { wallets: Set<string>; discountNgn: number; count: number; campaignIds: Set<string> }> = {};
    for (const r of recentDiscounted || []) {
      const ip = r.client_ip as string;
      if (!byIp[ip]) byIp[ip] = { wallets: new Set(), discountNgn: 0, count: 0, campaignIds: new Set() };
      byIp[ip].wallets.add(r.wallet_address);
      byIp[ip].discountNgn += Number(r.discount_ngn || 0);
      byIp[ip].count += 1;
      if (r.discount_campaign_id) byIp[ip].campaignIds.add(r.discount_campaign_id);
    }
    suspiciousClusters = Object.entries(byIp)
      .filter(([, v]) => v.wallets.size > 1)
      .map(([ip, v]) => ({ ip, walletCount: v.wallets.size, discountNgn: v.discountNgn, txCount: v.count, campaignIds: Array.from(v.campaignIds) }))
      .sort((a, b) => b.walletCount - a.walletCount)
      .slice(0, 20);
  }

  return NextResponse.json({
    success: true,
    campaigns: campaigns || [],
    settings: { fraudFlaggingEnabled },
    stats: {
      totalDiscountNgn: successfulRows.reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0),
      discountedTxCount: successfulRows.length,
      byCampaign,
      suspiciousClusters,
    },
  });
}

export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: auth.message }, { status: 401 });

  try {
    const body = await req.json();

    // Global toggle for the suspicious-cluster flagging feature — separate from any single
    // campaign, so it's a distinct body shape rather than overloading the campaign fields.
    if (typeof body.fraud_flagging_enabled === 'boolean') {
      const { error } = await supabaseAdmin
        .from('platform_settings')
        .update({ discount_fraud_flagging_enabled: body.fraud_flagging_enabled })
        .eq('id', 1);
      if (error) return NextResponse.json({ success: false, message: 'Could not save setting.' }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    const { id, name, type, value, max_discount_ngn, max_discount_per_wallet_ngn, max_discount_per_destination_ngn, max_discount_per_phone_ngn, max_total_discount_ngn, services, starts_at, ends_at, is_active } = body;

    const cleanServices = Array.isArray(services) && services.length > 0 ? services : null;
    const cleanNum = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

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
      if (max_discount_ngn !== undefined) update.max_discount_ngn = cleanNum(max_discount_ngn);
      if (max_discount_per_wallet_ngn !== undefined) update.max_discount_per_wallet_ngn = cleanNum(max_discount_per_wallet_ngn);
      if (max_discount_per_destination_ngn !== undefined) update.max_discount_per_destination_ngn = cleanNum(max_discount_per_destination_ngn);
      if (max_discount_per_phone_ngn !== undefined) update.max_discount_per_phone_ngn = cleanNum(max_discount_per_phone_ngn);
      if (max_total_discount_ngn !== undefined) update.max_total_discount_ngn = cleanNum(max_total_discount_ngn);
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
        max_discount_ngn: cleanNum(max_discount_ngn),
        max_discount_per_wallet_ngn: cleanNum(max_discount_per_wallet_ngn),
        max_discount_per_destination_ngn: cleanNum(max_discount_per_destination_ngn),
        max_discount_per_phone_ngn: cleanNum(max_discount_per_phone_ngn),
        max_total_discount_ngn: cleanNum(max_total_discount_ngn),
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
