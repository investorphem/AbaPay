import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { normalize } = await import('@/lib/deai/intentEngine');

// normalize() is the only thing standing between the model's free-form JSON and a payment
// intent, so it must turn ANY input into a safe ParsedIntent. These pin its behavior.

describe('normalize: well-formed model output', () => {
  it('keeps a valid airtime intent, uppercasing the provider and stripping account spaces', () => {
    const r = normalize({ intent: 'VEND_AIRTIME', provider: 'mtn', amount_ngn: '500', destination_account: '0801 234 5678', confidence_score: 0.9, missing: [] });
    expect(r).toMatchObject({ intent: 'VEND_AIRTIME', provider: 'MTN', amount_ngn: 500, destination_account: '08012345678', confidence_score: 0.9 });
  });

  it('keeps recurring fields, clamping day_of_month to 28', () => {
    const r = normalize({ intent: 'SCHEDULE_BILL', is_recurring: true, frequency: 'monthly', day_of_month: 31, day_of_week: 3 });
    expect(r).toMatchObject({ is_recurring: true, frequency: 'monthly', day_of_month: 28, day_of_week: 3, schedule_in_minutes: null });
  });

  it('caps a one-off schedule at 7 days, and drops it if the request is also recurring', () => {
    expect(normalize({ schedule_in_minutes: 99999 }).schedule_in_minutes).toBe(10080);
    expect(normalize({ schedule_in_minutes: 30, is_recurring: true }).schedule_in_minutes).toBeNull();
  });

  it('keeps 2+ actionable recipients and drops ones with no amount or account', () => {
    const r = normalize({ recipients: [
      { provider: 'mtn', amount_ngn: 100, destination_account: '0801' },
      { provider: 'glo', amount_ngn: 200, destination_account: '0802', chain: 'base', token: 'USA₮' },
      { provider: 'airtel', amount_ngn: 0, destination_account: '0803' },
      { provider: 'mtn', amount_ngn: 300 },
    ] });
    expect(r.recipients).toEqual([
      { provider: 'MTN', amount_ngn: 100, destination_account: '0801', chain: null, token: null },
      { provider: 'GLO', amount_ngn: 200, destination_account: '0802', chain: 'BASE', token: null }, // USA₮ is Celo-only
    ]);
  });

  it('a single recipient is not batch mode', () => {
    expect(normalize({ recipients: [{ amount_ngn: 100, destination_account: '0801' }] }).recipients).toBeNull();
  });

  it('clamps group-recharge fields', () => {
    const r = normalize({ group_recipient_count: 500, group_lookback_minutes: 4320, group_amount_ngn: 10000, group_service: 'DATA' });
    expect(r).toMatchObject({ group_recipient_count: 5, group_lookback_minutes: 360, group_amount_ngn: 500, group_service: 'DATA' });
  });

  it('accepts a known chain/token case-insensitively and a short language code', () => {
    expect(normalize({ chain: 'celo', token: 'usdc', language: ' YO ' })).toMatchObject({ chain: 'CELO', token: 'USDC', language: 'yo' });
  });
});

describe('normalize: hostile or malformed output becomes safe defaults', () => {
  for (const [label, input] of [['null', null], ['a string', 'VEND_AIRTIME'], ['an array', [1, 2]], ['a number', 42], ['empty', {}]] as const) {
    it(`${label} -> UNKNOWN with nothing filled in`, () => {
      const r = normalize(input);
      expect(r).toMatchObject({
        intent: 'UNKNOWN', provider: null, amount_ngn: null, destination_account: null, meter_type: null,
        confidence_score: 0, missing: [], is_recurring: false, frequency: null, recipients: null, chain: null, token: null, language: null,
      });
    });
  }

  it('rejects an invented intent, negative or non-numeric amounts, and wrong-typed fields', () => {
    const r = normalize({
      intent: 'DRAIN_WALLET', amount_ngn: -50, provider: 7, destination_account: { x: 1 }, meter_type: 'free',
      confidence_score: 'high', missing: ['amount', 3, null], is_recurring: 'yes', frequency: 'hourly',
      day_of_week: 9, day_of_month: 2.5, chain: 'ethereum', token: 'USDm', language: 'english please',
    });
    expect(r).toMatchObject({
      intent: 'UNKNOWN', amount_ngn: null, provider: null, destination_account: null, meter_type: null,
      confidence_score: 0, missing: ['amount'], is_recurring: false, frequency: null,
      day_of_week: null, day_of_month: null, chain: null, token: null, language: null,
    });
  });
});
