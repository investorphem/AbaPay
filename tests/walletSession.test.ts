import { describe, it, expect } from 'vitest';
import { walletSessionMessage, WALLET_SESSION_MAX_AGE_MS } from '@/lib/walletSession';

/**
 * 🔐 THE MESSAGE IS A CONTRACT BETWEEN TWO PROCESSES.
 *
 * The browser signs this exact string; the server rebuilds it from the timestamp and verifies the
 * signature against it. A difference of one character makes every signature fail — and it fails
 * as "invalid signature", which reads like a broken wallet rather than a changed string. These
 * pin the shape so a later edit has to be deliberate.
 */
describe('walletSessionMessage', () => {
  it('is built only from the timestamp, so both sides can reproduce it', () => {
    expect(walletSessionMessage('1787222935000')).toBe(walletSessionMessage('1787222935000'));
    expect(walletSessionMessage('1787222935000')).not.toBe(walletSessionMessage('1787222935001'));
  });

  it('carries the timestamp it was built from', () => {
    expect(walletSessionMessage('1787222935000')).toContain('1787222935000');
  });

  /**
   * 🔴 THE WORDING IS THE SECURITY CONTROL HERE. This is a signature request shown to someone in
   * their wallet, and the thing that makes phishing work is people learning to approve requests
   * they cannot read. It must say what it proves AND say that it moves nothing.
   */
  it('tells the user it authorises no payment', () => {
    const message = walletSessionMessage(Date.now().toString());
    expect(message).toMatch(/does NOT approve any payment/i);
    expect(message).toMatch(/prove/i);
  });

  /**
   * 🔴 AND IT MUST NOT COLLIDE WITH THE ACTION-SIGNATURE MESSAGE. walletAuthMessage() authorises
   * MUTATIONS (creating an agent link, resetting a PIN) and lasts five minutes. If a signature
   * gathered for this read-only, twelve-hour session could satisfy that verifier, this would
   * become a way to authorise those mutations for twelve hours instead.
   */
  it('cannot be mistaken for an agent-action signature', () => {
    expect(walletSessionMessage('1787222935000')).not.toMatch(/AbaPay Agent Action/);
  });

  it('lasts long enough to browse and short enough to expire', () => {
    expect(WALLET_SESSION_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
  });
});
