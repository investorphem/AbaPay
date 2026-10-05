import { describe, it, expect } from 'vitest';
import { pointsForPayment } from '@/lib/points';

describe('pointsForPayment', () => {
  it('is the stablecoin value of the bill', () => {
    expect(pointsForPayment({ amount_naira: 7370, fee_naira: 0, amount_usdt: 5.5 })).toBe(5.5); // ₦1,340/$
  });

  it("gives nothing for the fee's share of the charge", () => {
    // $2.10 charged for a ₦2,680 bill plus a ₦134 fee: 2.00 of it was the bill.
    expect(pointsForPayment({ amount_naira: 2680, fee_naira: 134, amount_usdt: 2.1 })).toBe(2);
  });

  it('accepts the string numerics a database row carries', () => {
    expect(pointsForPayment({ amount_naira: '1340', fee_naira: null, amount_usdt: '1' })).toBe(1);
  });

  it('is 0 for a row it cannot price', () => {
    expect(pointsForPayment({ amount_naira: 1340, amount_usdt: 0 })).toBe(0);
    expect(pointsForPayment({ amount_naira: 'x', amount_usdt: 1 })).toBe(0);
  });
});
