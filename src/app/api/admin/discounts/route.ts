import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { verifySignatureAcrossChains } from '@/utils/walletAuth';
import { buildDiscountCreateMessage, CONFIRM_SIGNATURE_MAX_AGE_MS } from '@/lib/adminActionMessages';

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

  // ⚡ Matches src/lib/discounts.ts's COUNTED_STATUSES exactly — SUCCESS, FAILED_VENDING, and
  // REFUNDED all consume a wallet/destination/phone/total cap (see that file's header comment
  // on why failed/refunded rows still count), so the numbers shown here must reflect the same
  // set the enforcement actually uses, or "budget exhausted" would never line up with the
  // displayed total.
  const COUNTED_STATUSES = ['SUCCESS', 'FAILED_VENDING', 'REFUNDED'];

  // Monitoring: how much has actually been discounted, and by which campaign.
  const { data: discounted } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn, discount_campaign_id, status')
    .gt('discount_ngn', 0);

  const rows = discounted || [];
  const countedRows = rows.filter((r: any) => COUNTED_STATUSES.includes(r.status));
  const byCampaign: Record<string, { discountNgn: number; count: number }> = {};
  for (const r of countedRows) {
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
    // Per-wallet breakdown (not just an aggregate count) so the admin can pick exactly which
    // wallet/destination to exclude, and from which campaign.
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentDiscounted } = await supabaseAdmin
      .from('transactions')
      .select('client_ip, wallet_address, account_number, discount_ngn, discount_campaign_id, created_at')
      .gt('discount_ngn', 0)
      .in('status', COUNTED_STATUSES)
      .not('client_ip', 'is', null)
      .gte('created_at', sinceIso);

    const byIp: Record<string, {
      wallets: Map<string, { discountNgn: number; count: number; campaignIds: Set<string>; accounts: Set<string> }>;
      discountNgn: number; count: number; campaignIds: Set<string>;
    }> = {};
    for (const r of recentDiscounted || []) {
      const ip = r.client_ip as string;
      if (!byIp[ip]) byIp[ip] = { wallets: new Map(), discountNgn: 0, count: 0, campaignIds: new Set() };
      const bucket = byIp[ip];
      if (!bucket.wallets.has(r.wallet_address)) bucket.wallets.set(r.wallet_address, { discountNgn: 0, count: 0, campaignIds: new Set(), accounts: new Set() });
      const w = bucket.wallets.get(r.wallet_address)!;
      w.discountNgn += Number(r.discount_ngn || 0);
      w.count += 1;
      if (r.discount_campaign_id) w.campaignIds.add(r.discount_campaign_id);
      if (r.account_number) w.accounts.add(r.account_number);

      bucket.discountNgn += Number(r.discount_ngn || 0);
      bucket.count += 1;
      if (r.discount_campaign_id) bucket.campaignIds.add(r.discount_campaign_id);
    }
    suspiciousClusters = Object.entries(byIp)
      .filter(([, v]) => v.wallets.size > 1)
      .map(([ip, v]) => ({
        ip,
        walletCount: v.wallets.size,
        discountNgn: v.discountNgn,
        txCount: v.count,
        campaignIds: Array.from(v.campaignIds),
        wallets: Array.from(v.wallets.entries()).map(([wallet, w]) => ({
          wallet, discountNgn: w.discountNgn, txCount: w.count,
          campaignIds: Array.from(w.campaignIds), accounts: Array.from(w.accounts),
        })),
      }))
      .sort((a, b) => b.walletCount - a.walletCount)
      .slice(0, 20);
  }

  const { data: exclusions } = await supabaseAdmin
    .from('discount_exclusions')
    .select('*')
    .order('created_at', { ascending: false });

  return NextResponse.json({
    success: true,
    campaigns: campaigns || [],
    settings: { fraudFlaggingEnabled },
    exclusions: exclusions || [],
    stats: {
      totalDiscountNgn: countedRows.reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0),
      discountedTxCount: countedRows.length,
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

    // Exclude a wallet and/or destination account from one campaign — the admin action off the
    // "Suspicious activity" panel. Enforced in src/lib/discounts.ts's isExcluded().
    if (body.exclude) {
      const { campaign_id, wallet_address, account_number, reason } = body.exclude;
      if (!campaign_id) return NextResponse.json({ success: false, message: 'campaign_id is required' }, { status: 400 });
      if (!wallet_address && !account_number) return NextResponse.json({ success: false, message: 'wallet_address or account_number is required' }, { status: 400 });

      const { error } = await supabaseAdmin.from('discount_exclusions').insert({
        campaign_id,
        wallet_address: wallet_address ? String(wallet_address).toLowerCase() : null,
        account_number: account_number || null,
        reason: reason || null,
        created_by: auth.address,
      });
      if (error) return NextResponse.json({ success: false, message: 'Could not save exclusion.' }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    const { id, name, type, value, max_discount_ngn, max_discount_per_wallet_ngn, max_discount_per_destination_ngn, max_discount_per_phone_ngn, max_total_discount_ngn, services, starts_at, ends_at, is_active, confirmSignature, confirmTimestamp } = body;

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

    // 🔒 STEP-UP CONFIRMATION — creating a campaign is a distinct, high-risk action (it's a
    // live lever on real revenue), so it requires a FRESH wallet signature over these exact
    // parameters, not just the standard 12h admin session header (verifyAdminRequest above).
    // A hijacked/replayed session (stolen headers, a compromised admin browser tab) proves
    // "someone holds these headers" — it does NOT prove live control of the admin's wallet.
    // Forcing a brand-new signMessage() prompt here means an attacker without the wallet
    // extension itself cannot complete this action even with a fully valid session.
    if (!confirmSignature || !confirmTimestamp) {
      return NextResponse.json({ success: false, message: 'Missing wallet confirmation — please sign to confirm creating this campaign.' }, { status: 400 });
    }
    const confirmTs = Number(confirmTimestamp);
    if (!Number.isFinite(confirmTs) || Date.now() - confirmTs > CONFIRM_SIGNATURE_MAX_AGE_MS || confirmTs > Date.now() + 60_000) {
      return NextResponse.json({ success: false, message: 'Confirmation expired — please try creating the campaign again.' }, { status: 401 });
    }
    const confirmMessage = buildDiscountCreateMessage({ name: String(name), type, value: v, timestamp: confirmTs });
    // Smart-wallet-aware (Coinbase Smart Wallet / Base Account, Safe, etc. via ERC-1271/6492,
    // with a plain ECDSA fast path for ordinary EOAs) — see src/utils/walletAuth.ts.
    const validSig = await verifySignatureAcrossChains(String(auth.address), confirmMessage, String(confirmSignature));
    if (!validSig) return NextResponse.json({ success: false, message: 'Signature does not match — campaign not created.' }, { status: 401 });

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
  const type = searchParams.get('type') || 'campaign';
  if (!id) return NextResponse.json({ success: false, message: 'Missing id' }, { status: 400 });

  const table = type === 'exclusion' ? 'discount_exclusions' : 'discount_campaigns';
  const { error } = await supabaseAdmin.from(table).delete().eq('id', id);
  if (error) return NextResponse.json({ success: false, message: `Could not delete ${type}.` }, { status: 500 });
  return NextResponse.json({ success: true });
}
