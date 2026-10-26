import { describe, it, expect } from 'vitest';
import { electricityMeterType } from '@/lib/meterType';

describe('electricityMeterType', () => {
  it('takes the first field that actually says prepaid or postpaid', () => {
    expect(electricityMeterType('postpaid', 'NMD')).toBe('postpaid'); // web app
    expect(electricityMeterType(undefined, 'Prepaid')).toBe('prepaid'); // agents, SDK
    expect(electricityMeterType('none', 'POSTPAID')).toBe('postpaid');
  });

  it('never passes an account class through as a meter type', () => {
    expect(electricityMeterType('NMD', 'MD')).toBeUndefined();
    expect(electricityMeterType(null, undefined)).toBeUndefined();
  });
});
