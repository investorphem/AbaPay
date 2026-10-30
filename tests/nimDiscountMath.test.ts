import { describe, it, expect } from 'vitest';
import { nimDiscountNgn, percentLabel } from '@/lib/nimDiscountMath';

// The NIM discount's arithmetic, shared by /api/pay/nim and the mini app's estimate.
describe('nimDiscountNgn', () => {
  it('is 0 while switched off, whatever the percentage', () => {
    expect(nimDiscountNgn(1000, { enabled: false, percent: 50 })).toBe(0);
    expect(nimDiscountNgn(1000, null)).toBe(0);
    expect(nimDiscountNgn(1000, undefined)).toBe(0);
  });

  it('takes the percentage off the bill, to the kobo', () => {
    expect(nimDiscountNgn(1000, { enabled: true, percent: 10 })).toBe(100);
    expect(nimDiscountNgn(333, { enabled: true, percent: 12.5 })).toBe(41.63);
    expect(nimDiscountNgn(100, { enabled: true, percent: 99.99 })).toBe(99.99);
  });

  it('gives nothing for a zero bill or a zero percentage', () => {
    expect(nimDiscountNgn(0, { enabled: true, percent: 10 })).toBe(0);
    expect(nimDiscountNgn(1000, { enabled: true, percent: 0 })).toBe(0);
  });
});

describe('percentLabel', () => {
  it('drops trailing zeros', () => {
    expect(percentLabel(10)).toBe('10%');
    expect(percentLabel(12.5)).toBe('12.5%');
    expect(percentLabel(7.125)).toBe('7.13%');
  });
});
