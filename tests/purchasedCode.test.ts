import { describe, it, expect } from 'vitest';
import { normalizePurchasedCode, issuesTokenOrPin } from '@/lib/purchasedCode';
import { logoForServiceId } from '@/lib/providerFallback';

/**
 * These lock in the two rules behind the "Token : Token : N/A" receipt bug.
 *
 * VTpass does not omit `purchased_code` when no token was issued — it returns the literal
 * string "Token : N/A". Every vend path stored that verbatim, and the receipt email then
 * prefixed its own "Token : " label, so a customer whose meter token had NOT been issued
 * received a receipt announcing a token of "N/A". Both halves are covered: the label VTpass
 * bakes into the value, and the placeholder that must not survive as a code.
 */
describe('normalizePurchasedCode', () => {
  it('rejects the exact placeholder VTpass sent on the reported receipt', () => {
    expect(normalizePurchasedCode('Token : N/A')).toBeNull();
  });

  it('treats every placeholder spelling as "no token", case-insensitively', () => {
    for (const raw of ['N/A', 'n/a', ' NA ', 'nil', 'none', 'null', '', '   ', 'Vended Successfully']) {
      expect(normalizePurchasedCode(raw)).toBeNull();
    }
  });

  it('returns null for a missing value rather than the string "null"', () => {
    expect(normalizePurchasedCode(null)).toBeNull();
    expect(normalizePurchasedCode(undefined)).toBeNull();
  });

  it('strips the label VTpass bakes in, so the email cannot double it', () => {
    expect(normalizePurchasedCode('Token : 1234-5678-9012-3456-7890')).toBe('1234-5678-9012-3456-7890');
    expect(normalizePurchasedCode('Token: 01234567890123456789')).toBe('01234567890123456789');
    expect(normalizePurchasedCode('PIN - 998877')).toBe('998877');
  });

  it('leaves a real token untouched', () => {
    expect(normalizePurchasedCode('1234567890123456')).toBe('1234567890123456');
    expect(normalizePurchasedCode('  4455 6677 8899  ')).toBe('4455 6677 8899');
  });

  // A WAEC PIN is alphanumeric and could plausibly start with letters — make sure the label
  // strip is anchored to a real "label:" prefix and can't eat the start of a genuine code.
  it('does not mistake a code that merely starts with letters for a label', () => {
    expect(normalizePurchasedCode('TOKENA1B2C3')).toBe('TOKENA1B2C3');
    expect(normalizePurchasedCode('PINCODE12345')).toBe('PINCODE12345');
  });
});

/**
 * ⚡ THE REGRESSION GUARD THAT MATTERS MOST HERE.
 *
 * Only PREPAID electricity meters get a token — postpaid is a billed account, which is exactly
 * why VTpass answers a postpaid vend with the "Token : N/A" placeholder.
 *
 * /api/requery and reconcileStuck refuse to mark an electricity payment SUCCESS until a token
 * exists. That gate only ever passed for postpaid because the placeholder string happened to be
 * truthy — so normalising placeholders to null (correct on its own) would, without this
 * function, hold every postpaid payment at PENDING forever, waiting on a token the provider is
 * never going to send. These cases pin that down.
 */
describe('issuesTokenOrPin', () => {
  it('says NO for postpaid electricity — the case that would otherwise strand a payment', () => {
    expect(issuesTokenOrPin('ELECTRICITY', 'postpaid')).toBe(false);
    expect(issuesTokenOrPin('ELECTRICITY', 'POSTPAID')).toBe(false);
    expect(issuesTokenOrPin('ELECTRICITY', ' Postpaid ')).toBe(false);
  });

  it('says YES for prepaid electricity, which does issue a meter token', () => {
    expect(issuesTokenOrPin('ELECTRICITY', 'prepaid')).toBe(true);
  });

  // Two historical rows carry a null variation_code. Holding for review beats silently
  // completing a prepaid purchase whose token the customer actually needs.
  it('treats an unknown meter type as prepaid (the conservative direction)', () => {
    expect(issuesTokenOrPin('ELECTRICITY', null)).toBe(true);
    expect(issuesTokenOrPin('ELECTRICITY', undefined)).toBe(true);
    expect(issuesTokenOrPin('ELECTRICITY', '')).toBe(true);
  });

  it('always says YES for education, whose variation is a plan code, not a meter type', () => {
    expect(issuesTokenOrPin('EDUCATION', 'waec')).toBe(true);
    expect(issuesTokenOrPin('EDUCATION', null)).toBe(true);
  });

  it('says NO for categories that never produce a code', () => {
    for (const category of ['AIRTIME', 'DATA', 'CABLE', 'INTERNET', 'BANK', null, undefined]) {
      expect(issuesTokenOrPin(category, 'prepaid')).toBe(false);
    }
  });
});

/**
 * Receipts are read months later, and email clients fetch images through a proxy — so a
 * receipt logo must resolve to a bundled asset on our own domain, never a VTpass CDN URL,
 * and an unknown service must degrade to the AbaPay mark rather than a broken image.
 */
describe('logoForServiceId', () => {
  it('resolves a known VTpass serviceID to its bundled artwork', () => {
    expect(logoForServiceId('ibadan-electric')).toBe('/ibadan.png');
    expect(logoForServiceId('mtn')).toBe('/mtn.png');
    expect(logoForServiceId('dstv')).toBe('/dstv.png');
  });

  // `service_id` is lowercase but `network` holds an uppercased variant, and callers pass
  // whichever they have.
  it('matches case-insensitively and tolerates surrounding whitespace', () => {
    expect(logoForServiceId('IBADAN-ELECTRIC')).toBe('/ibadan.png');
    expect(logoForServiceId('  Dstv  ')).toBe('/dstv.png');
  });

  it('falls back to the AbaPay mark instead of a broken image', () => {
    expect(logoForServiceId(null)).toBe('/logo.png');
    expect(logoForServiceId(undefined)).toBe('/logo.png');
    expect(logoForServiceId('')).toBe('/logo.png');
    expect(logoForServiceId('some-service-vtpass-added-yesterday')).toBe('/logo.png');
  });

  it('produces an absolute URL for email, where a root-relative path has no origin', () => {
    const url = logoForServiceId('ibadan-electric', true);
    expect(url).toMatch(/^https?:\/\/.+\/ibadan\.png$/);
    expect(url).not.toContain('//ibadan.png');
  });
});
