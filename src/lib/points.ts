// AbaPoints for a recorded payment: the stablecoin value of the bill, to two decimals (the docs'
// "spend 5.50 USDC, earn 5.50 points"). Derived from the row itself, so the paths that complete
// a payment late (the VTpass push, /api/requery, the stuck-payment reconciler) award exactly what
// the live path would have. Two of them used to award `amount_naira / 1000`, which at ~₦1,340/$
// was about a third too many.
//
// The rate is the one the payer actually paid at: (bill + fee) / stablecoin charged, so the fee's
// share of the charge earns nothing, matching the live path's `vendAmount / baseRate`.
export function pointsForPayment(row: { amount_naira: unknown; fee_naira?: unknown; amount_usdt: unknown }): number {
  const naira = Number(row.amount_naira);
  const rate = (naira + Number(row.fee_naira || 0)) / Number(row.amount_usdt);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(naira)) return 0;
  return Number((naira / rate).toFixed(2));
}
