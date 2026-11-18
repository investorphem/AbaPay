import { describe, it, expect } from 'vitest';
import { networkForPhone, NETWORK_DATA_SERVICES } from '@/lib/phoneNetwork';
import { vtpassAdminError, vtpassDescription } from '@/lib/vtpassCodes';

describe('networkForPhone', () => {
  it.each([
    ['08145043264', 'mtn'], // the 2026-11-05 NIM order bought as Airtel
    ['08168811821', 'mtn'],
    ['09072297621', 'airtel'],
    ['08051234567', 'glo'],
    ['09091234567', 'etisalat'],
    ['+2348031234567', 'mtn'],
    ['0803 123 4567', 'mtn'],
  ])('%s → %s', (phone, network) => expect(networkForPhone(phone)).toBe(network));

  it('is null for an unknown prefix or a number too short to tell', () => {
    expect(networkForPhone('0700')).toBeNull();
    expect(networkForPhone('080')).toBeNull();
    expect(networkForPhone('')).toBeNull();
  });

  it('keeps both data services a network sells', () => {
    expect(NETWORK_DATA_SERVICES.glo).toEqual(['glo-data', 'glo-sme-data']);
    expect(NETWORK_DATA_SERVICES.etisalat).toEqual(['etisalat-data', '9mobile-sme-data']);
  });
});

describe('VTpass code text for the admin', () => {
  it('names 087 and its likely cause when VTpass sends no description', () => {
    expect(vtpassAdminError('087', undefined)).toMatch(/^087 INVALID CREDENTIALS — .*VTPASS_API_KEY/);
    expect(vtpassDescription('087', undefined)).toBe('INVALID CREDENTIALS');
  });

  it("prefers VTpass's own description when it sends one", () => {
    expect(vtpassDescription('016', 'TRANSACTION FAILED')).toBe('TRANSACTION FAILED');
    expect(vtpassAdminError('016', 'TRANSACTION FAILED')).toMatch(/different network/);
  });

  it('never prints "undefined" for an unknown code', () => {
    expect(vtpassAdminError('999', undefined)).toBe('999 no description from VTpass');
  });
});
