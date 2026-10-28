// The amount range a person may enter for an airtime or electricity bill, from the provider's
// VTpass limits plus AbaPay's own floors. One rule for abapays.com and the Nimiq Pay mini app,
// which used to show VTpass's raw numbers (₦10 for MTN airtime, ₦100 for Ikeja electricity)
// while abapays.com required ₦100 and ₦1,000.
//
// - Airtime: at least ₦100, or the provider's own minimum if higher (Airtel ₦50 → ₦100).
// - Electricity: at least ₦1,000 until the meter is checked, then the meter's own minimum
//   purchase; never below the disco's VTpass minimum (Ibadan ₦2,000).
// - Ceilings are the provider's VTpass maximum, with the previous flat values when VTpass
//   publishes none, so "unknown" never becomes "unlimited".
export const AIRTIME_MIN_NGN = 100;
export const AIRTIME_FALLBACK_MAX_NGN = 50_000;
export const ELECTRICITY_DEFAULT_MIN_NGN = 1_000;
export const ELECTRICITY_FALLBACK_MAX_NGN = 1_000_000;

export type AmountLimits = { min: number | null; max: number | null };

export function billAmountLimits(
  category: string,
  provider: { min?: number | null; max?: number | null },
  meterMinPurchase?: number | null,
): AmountLimits {
  const vtMin = provider.min ?? 0;
  if (category === 'AIRTIME') {
    return { min: Math.max(AIRTIME_MIN_NGN, vtMin), max: provider.max ?? AIRTIME_FALLBACK_MAX_NGN };
  }
  if (category === 'ELECTRICITY') {
    return { min: Math.max(meterMinPurchase ?? ELECTRICITY_DEFAULT_MIN_NGN, vtMin), max: provider.max ?? ELECTRICITY_FALLBACK_MAX_NGN };
  }
  return { min: null, max: null };
}
