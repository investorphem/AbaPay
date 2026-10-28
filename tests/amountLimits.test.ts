import { describe, it, expect } from 'vitest';
import { billAmountLimits } from '@/lib/amountLimits';

// One amount rule for abapays.com and the Nimiq Pay mini app (2026-10-28: the mini app showed
// VTpass's raw ₦10 MTN / ₦100 Ikeja minimums).
describe('billAmountLimits', () => {
  it('airtime: AbaPay ₦100 floor unless the network is stricter; VTpass ceiling', () => {
    expect(billAmountLimits('AIRTIME', { min: 10, max: 200_000 })).toEqual({ min: 100, max: 200_000 }); // MTN
    expect(billAmountLimits('AIRTIME', { min: 150, max: 50_000 })).toEqual({ min: 150, max: 50_000 });
    expect(billAmountLimits('AIRTIME', {})).toEqual({ min: 100, max: 50_000 });
  });

  it('electricity: ₦1,000 until the meter is checked, then its own minimum, never below the disco', () => {
    expect(billAmountLimits('ELECTRICITY', { min: 100, max: 1_000_000 })).toEqual({ min: 1_000, max: 1_000_000 }); // Ikeja
    expect(billAmountLimits('ELECTRICITY', { min: 100 }, 500)).toEqual({ min: 500, max: 1_000_000 });
    expect(billAmountLimits('ELECTRICITY', { min: 2_000, max: 500_000 }, 500)).toEqual({ min: 2_000, max: 500_000 }); // Ibadan
  });

  it('other services have no typed-amount range here', () => {
    expect(billAmountLimits('DATA', { min: 50, max: 100 })).toEqual({ min: null, max: null });
  });
});
