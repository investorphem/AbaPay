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
  maxDiscountNgn: number | null;               // per-transaction cap
  maxDiscountPerWalletNgn: number | null;      // lifetime cap for one wallet under this campaign
  maxDiscountPerDestinationNgn: number | null; // rolling 24h cap for one destination account/meter
  maxDiscountPerPhoneNgn: number | null;       // lifetime cap for one VERIFIED phone number
  maxTotalDiscountNgn: number | null;          // lifetime cap across the whole campaign
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

// ⚡ COUNTED TOWARD EVERY CAP: SUCCESS, FAILED_VENDING, and REFUNDED — deliberately NOT just
// SUCCESS. The earlier version only counted SUCCESS on the theory that a failed/refunded vend
// paid the (already-discounted) crypto back in full and so "cost the campaign nothing" — but
// that let a wallet/destination/phone rack up unlimited discounted attempts for free as long as
// each one failed, resetting its allowance every time regardless of how many discounted
// payments it had actually pushed through the system. Counting failed/refunded rows too closes
// that off: a cap is consumed the moment a discount is GRANTED, not only once it's confirmed
// delivered. PENDING/PROCESSING (still in-flight) and EXPIRED (payment never actually landed
// on-chain — see cleanupPreflights.ts) are excluded since no discount was genuinely extended yet.
const COUNTED_STATUSES = ['SUCCESS', 'FAILED_VENDING', 'REFUNDED'];

async function totalGivenForCampaign(campaignId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn')
    .eq('discount_campaign_id', campaignId)
    .in('status', COUNTED_STATUSES);
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0);
}

async function totalGivenForWallet(campaignId: string, walletAddress: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn')
    .eq('discount_campaign_id', campaignId)
    .eq('wallet_address', walletAddress.toLowerCase())
    .in('status', COUNTED_STATUSES);
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0);
}

/** Rolling 24h window, not a calendar day — a destination that used its allowance at 11pm can
 * use it again at 11pm the next day, not at midnight. Resets automatically; nothing to clear. */
async function totalGivenForDestination(campaignId: string, accountNumber: string): Promise<number> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn')
    .eq('discount_campaign_id', campaignId)
    .eq('account_number', accountNumber)
    .in('status', COUNTED_STATUSES)
    .gte('created_at', sinceIso);
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0);
}

/** The wallet's VERIFIED phone number, if any (wallet_links.user_id -> abapay_users.verified_phone
 * — same join src/app/api/user/points/route.ts uses). Null for guests/unlinked wallets — a real
 * SIM registration is what makes this a meaningfully stronger identity signal than a wallet
 * address, so a wallet with none here simply doesn't qualify for a phone-capped campaign. */
async function resolveVerifiedPhone(walletAddress: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('wallet_links')
    .select('abapay_users(verified_phone)')
    .eq('wallet_address', walletAddress.toLowerCase())
    .maybeSingle();
  if (!data) return null;
  const profile: any = Array.isArray((data as any).abapay_users) ? (data as any).abapay_users[0] : (data as any).abapay_users;
  return profile?.verified_phone || null;
}

/** Lifetime, like the wallet cap — a verified phone doesn't reset like a destination number
 * does, since the point is capping a real human's total take, not a returning customer. */
async function totalGivenForPhone(campaignId: string, phone: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('discount_ngn')
    .eq('discount_campaign_id', campaignId)
    .eq('discount_phone', phone)
    .in('status', COUNTED_STATUSES);
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.discount_ngn || 0), 0);
}

/** Manual admin override — set from the "Suspicious activity" panel in the admin Discounts tab
 * after reviewing a flagged IP/device cluster. Checked before anything else in
 * computeDiscountNgn(), so an excluded wallet/destination gets the normal, undiscounted price
 * with no further computation. Scoped per-campaign (matching "remove such from the campaign"),
 * not a global ban — the same wallet can still use a DIFFERENT campaign. */
async function isExcluded(campaignId: string, walletAddress?: string | null, destinationAccount?: string | null): Promise<boolean> {
  if (!walletAddress && !destinationAccount) return false;
  const orParts: string[] = [];
  if (walletAddress) orParts.push(`wallet_address.eq.${walletAddress.toLowerCase()}`);
  if (destinationAccount) orParts.push(`account_number.eq.${destinationAccount}`);

  const { data } = await supabaseAdmin
    .from('discount_exclusions')
    .select('id')
    .eq('campaign_id', campaignId)
    .or(orParts.join(','))
    .limit(1);
  return !!(data && data.length > 0);
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
      maxDiscountPerDestinationNgn: c.max_discount_per_destination_ngn != null ? Number(c.max_discount_per_destination_ngn) : null,
      maxDiscountPerPhoneNgn: c.max_discount_per_phone_ngn != null ? Number(c.max_discount_per_phone_ngn) : null,
      maxTotalDiscountNgn: c.max_total_discount_ngn != null ? Number(c.max_total_discount_ngn) : null,
    };
  }
  return null;
}

export interface DiscountResult {
  discountNgn: number;
  /** The verified phone this discount was attributed to, if the campaign has a phone cap —
   * callers should record this on the transaction row (see the migration's header comment on
   * transactions.discount_phone) so later accounting doesn't depend on a phone link that could
   * change afterward. */
  discountPhone: string | null;
}

/**
 * Naira discount for a given bill amount — capped at the campaign's per-transaction ceiling,
 * clamped further by whatever room is left under the per-wallet, per-destination (24h,
 * rolling — see totalGivenForDestination), per-verified-phone, and total-campaign caps
 * (whichever are set), and never more than the bill itself. `walletAddress`/`destinationAccount`
 * are optional only because a caller may not know them yet (e.g. a guest quote before an
 * account number is entered); a discount with a cap set but the matching identifier unknown is
 * denied outright rather than risk over-granting it — this includes the phone cap, which means
 * enabling it effectively requires phone verification to participate in that campaign at all.
 */
export async function computeDiscountNgn(
  baseNgn: number,
  discount: ActiveDiscount | null,
  walletAddress?: string | null,
  destinationAccount?: string | null,
): Promise<DiscountResult> {
  const deny: DiscountResult = { discountNgn: 0, discountPhone: null };
  if (!discount || !(baseNgn > 0)) return deny;

  if (await isExcluded(discount.id, walletAddress, destinationAccount)) return deny;

  let raw = discount.type === 'PERCENT' ? (baseNgn * discount.value) / 100 : discount.value;
  if (discount.maxDiscountNgn != null) raw = Math.min(raw, discount.maxDiscountNgn);
  raw = Math.max(0, Math.min(raw, baseNgn));
  if (raw === 0) return deny;

  if (discount.maxDiscountPerWalletNgn != null) {
    if (!walletAddress) return deny; // can't verify the wallet cap — don't guess, don't over-grant
    const givenToWallet = await totalGivenForWallet(discount.id, walletAddress);
    const roomLeft = Math.max(0, discount.maxDiscountPerWalletNgn - givenToWallet);
    raw = Math.min(raw, roomLeft);
  }

  if (discount.maxDiscountPerDestinationNgn != null && raw > 0) {
    if (!destinationAccount) return deny;
    const givenToDestination = await totalGivenForDestination(discount.id, destinationAccount);
    const roomLeft = Math.max(0, discount.maxDiscountPerDestinationNgn - givenToDestination);
    raw = Math.min(raw, roomLeft);
  }

  let discountPhone: string | null = null;
  if (discount.maxDiscountPerPhoneNgn != null && raw > 0) {
    if (!walletAddress) return deny;
    discountPhone = await resolveVerifiedPhone(walletAddress);
    if (!discountPhone) return deny; // no verified phone — doesn't qualify for a phone-capped campaign
    const givenToPhone = await totalGivenForPhone(discount.id, discountPhone);
    const roomLeft = Math.max(0, discount.maxDiscountPerPhoneNgn - givenToPhone);
    raw = Math.min(raw, roomLeft);
  }

  if (discount.maxTotalDiscountNgn != null && raw > 0) {
    const givenTotal = await totalGivenForCampaign(discount.id);
    const roomLeft = Math.max(0, discount.maxTotalDiscountNgn - givenTotal);
    raw = Math.min(raw, roomLeft);
  }

  if (raw === 0) return deny;
  return { discountNgn: raw, discountPhone };
}
