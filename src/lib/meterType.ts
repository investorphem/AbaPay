// An electricity meter's type, prepaid or postpaid, from whichever field a caller put it in.
//
// The rails disagree on where it goes. The web app and the Nimiq app send it as
// `variation_code` and use `meter_account_type` for VTpass's account class (e.g. "NMD", "MD").
// Agents, the SDK, chat and the scheduler send it as `meter_account_type`. Reading either field
// alone sent "NMD" to VTpass as the meter type (2026-10-26: a valid Ibadan postpaid meter was
// refunded as "not a valid NMD meter" before any purchase was tried), or reached the vend with
// no type at all.
export type MeterType = 'prepaid' | 'postpaid';

export function electricityMeterType(...candidates: (string | null | undefined)[]): MeterType | undefined {
  for (const c of candidates) {
    const v = String(c ?? '').trim().toLowerCase();
    if (v === 'prepaid' || v === 'postpaid') return v;
  }
  return undefined;
}
