import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';

// ⚡ SHARED DISCOUNT ENGINE — one source of truth for both the web app's /api/pay verification
// and the chat/agent path (src/app/api/deai/core/route.ts), mirroring the exact pattern
// src/lib/serviceRules.ts already uses for kill switches: a short-lived cache, read fresh on
// every check, so an operator's change in the admin dashboard is live within CACHE_MS with no
// redeploy. The web app's own discount preview (src/app/api/discounts/active/route.ts) is
// purely cosmetic — this module, called again inside /api/pay/route.ts, is what's actually
// enforced. A tampered client claiming a fake/bigger discount just ends up underpaying, which
// /api/pay already rejects the same way it rejects any other insufficient payment.

export interface ActiveDiscount {
  id: string;
  name: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  maxDiscountNgn: number | null;         // per-transaction cap
  maxDiscountPerWalletNgn: number | null; // lifetime cap for one wallet under this campaign
  maxTotalDiscountNgn: number | null;     // lifetime cap across the whole campaign
}

let cache: { rows: any[]; at: number } | null = null;
const CACHE_MS = 30_000;

async function loadActiveCampaigns(): Promise<any[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;

  const nowIso = new Date().toISOString();
  try {
    const { data } = await supabaseAdmin
      .from('discount_campaigns')
      .select('*')
      .eq('is_active', true)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`);
    cache = { rows: data || [], at: Date.now() };
  } catch (err) {
    console.error('[Discounts] Failed to load campaigns:', err);
    if (!cache) cache = { rows: [], at: Date.now() };
  }
  return cache.rows;
}

/** Sum of discount_ngn already given under this campaign, successful transactions only — a
 * failed/refunded vend paid back the (already-discounted) crypto in full, so it cost the
 * campaign nothing and shouldn't count against either cap. */
async function totalGivenForCampaign(campaignId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn')
    .eq('discount_campaign_id', campaignId)
    .eq('status', 'SUCCESS');
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0);
}

async function totalGivenForWallet(campaignId: string, walletAddress: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn')
    .eq('discount_campaign_id', campaignId)
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('status', 'SUCCESS');
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0);
}

/**
 * The single active campaign (if any) that applies to `serviceKey` — one of the canonical
 * keys killSwitchKeyFor() maps intents/tabs to (AIRTIME, DATA, INTERNET, ELECTRICITY, CABLE,
 * BANK, EDUCATION). A campaign with no `services` list applies to every service.
 *
 * A campaign whose max_total_discount_ngn has already been fully given away is treated as
 * inactive here — transactions simply fall back to the normal, undiscounted flow with no
 * manual deactivation needed (see the migration's header comment).
 *
 * Tie-break when more than one campaign matches: a campaign scoped to THIS specific service
 * wins over a global (all-services) one; among ties, the most recently created wins. Running
 * two overlapping campaigns on the same service is an operator mistake, not something worth
 * building stacking/combination logic for.
 */
export async function getActiveDiscountForService(serviceKey: string | null): Promise<ActiveDiscount | null> {
  const campaigns = await loadActiveCampaigns();
  const matches = campaigns.filter(
    (c: any) => !c.services || c.services.length === 0 || (serviceKey && c.services.includes(serviceKey))
  );
  if (matches.length === 0) return null;

  matches.sort((a: any, b: any) => {
    const aSpecific = a.services && a.services.length > 0 ? 1 : 0;
    const bSpecific = b.services && b.services.length > 0 ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  for (const c of matches) {
    if (c.max_total_discount_ngn != null) {
      const givenSoFar = await totalGivenForCampaign(c.id);
      if (givenSoFar >= Number(c.max_total_discount_ngn)) continue; // budget exhausted — skip, try next match
    }
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      value: Number(c.value),
      maxDiscountNgn: c.max_discount_ngn != null ? Number(c.max_discount_ngn) : null,
      maxDiscountPerWalletNgn: c.max_discount_per_wallet_ngn != null ? Number(c.max_discount_per_wallet_ngn) : null,
      maxTotalDiscountNgn: c.max_total_discount_ngn != null ? Number(c.max_total_discount_ngn) : null,
    };
  }
  return null;
}

/**
 * Naira discount for a given bill amount — capped at the campaign's per-transaction ceiling,
 * clamped further by whatever room is left under the per-wallet and total-campaign caps (if
 * either is set), and never more than the bill itself. `walletAddress` is optional only
 * because the caller may not know it yet (e.g. a guest quote); a discount with a per-wallet
 * cap but no known wallet is denied outright rather than risk over-granting it.
 */
export async function computeDiscountNgn(baseNgn: number, discount: ActiveDiscount | null, walletAddress?: string | null): Promise<number> {
  if (!discount || !(baseNgn > 0)) return 0;

  let raw = discount.type === 'PERCENT' ? (baseNgn * discount.value) / 100 : discount.value;
  if (discount.maxDiscountNgn != null) raw = Math.min(raw, discount.maxDiscountNgn);
  raw = Math.max(0, Math.min(raw, baseNgn));
  if (raw === 0) return 0;

  if (discount.maxDiscountPerWalletNgn != null) {
    if (!walletAddress) return 0; // can't verify the wallet cap — don't guess, don't over-grant
    const givenToWallet = await totalGivenForWallet(discount.id, walletAddress);
    const roomLeft = Math.max(0, discount.maxDiscountPerWalletNgn - givenToWallet);
    raw = Math.min(raw, roomLeft);
  }

  if (discount.maxTotalDiscountNgn != null && raw > 0) {
    const givenTotal = await totalGivenForCampaign(discount.id);
    const roomLeft = Math.max(0, discount.maxTotalDiscountNgn - givenTotal);
    raw = Math.min(raw, roomLeft);
  }

  return raw;
}
