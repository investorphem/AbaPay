import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import type { NimDiscount } from '@/lib/nimDiscountMath';

// ⚡ THE NIM DISCOUNT SWITCH — platform_settings.nim_discount_enabled / nim_discount_percent,
// set from the admin Discounts tab (src/app/api/admin/discounts/route.ts). Read with the same
// short cache src/lib/discounts.ts uses, so a change is live within CACHE_MS with no redeploy.
// Failing to read it prices the order with no discount: never a discount nobody switched on.

const OFF: NimDiscount = { enabled: false, percent: 0 };
const CACHE_MS = 30_000;
let cache: { value: NimDiscount; at: number } | null = null;

export async function getNimDiscount(): Promise<NimDiscount> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const { data } = await supabaseAdmin
      .from('platform_settings')
      .select('nim_discount_enabled, nim_discount_percent')
      .eq('id', 1)
      .single();
    const percent = Number(data?.nim_discount_percent) || 0;
    const value = data?.nim_discount_enabled === true && percent > 0 && percent < 100 ? { enabled: true, percent } : OFF;
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error('[NimDiscount] Failed to read the setting:', err);
    return cache?.value ?? OFF;
  }
}

/** For the admin route after a save, so the next order on this instance sees it at once. */
export function clearNimDiscountCache() {
  cache = null;
}
