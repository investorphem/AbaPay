// The NIM discount's arithmetic, shared by the server (/api/pay/nim, which binds the price) and
// the mini app's live estimate, so the two always agree. Pure: no imports, safe on the client.
// The switch and percentage themselves are read server-side by src/lib/nimDiscount.ts.

export interface NimDiscount {
  enabled: boolean;
  /** 0 ≤ percent < 100 (the column's check constraint, see migration 045). */
  percent: number;
}

/** Naira off a bill's face value: rounded to the kobo, never the whole bill. 0 while switched off. */
export function nimDiscountNgn(billNgn: number, discount: NimDiscount | null | undefined): number {
  if (!discount?.enabled || !(discount.percent > 0) || !(billNgn > 0)) return 0;
  const off = Math.round(billNgn * discount.percent) / 100;
  return Math.max(0, Math.min(off, billNgn));
}

/** "10%", "12.5%": for labels. */
export function percentLabel(percent: number): string {
  return `${Number(percent.toFixed(2))}%`;
}
