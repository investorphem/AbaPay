import { describe, it, expect } from 'vitest';
import { channelLabel } from '@/lib/channelLabel';

// The Source line of the Telegram sale/refund alerts and the admin Ops panel. Agent payments
// used to fall through to "🌐 Web App" (2026-10-24).
describe('channelLabel', () => {
  it.each([
    ['WEB', '🌐 Web App'],
    ['AGENT', '🤖 x402 Agent'],
    ['MCP', '🤖 MCP/A2A Agent'],
    ['NIMIQ', '🟡 Nimiq Pay Mini App'],
    ['TELEGRAM', '💬 Telegram Agent'],
    ['WHATSAPP', '💬 WhatsApp Agent'],
    ['X', '💬 X Agent'],
    ['SCHEDULE', '🤖 Autonomous Schedule'],
  ])('%s → %s', (src, label) => {
    expect(channelLabel(src)).toBe(label);
    expect(channelLabel(src.toLowerCase())).toBe(label);
  });

  it('never calls an unknown source the web app', () => {
    expect(channelLabel('SOMETHING')).toBe('🤖 SOMETHING');
    expect(channelLabel(null)).toBe('🌐 Web App'); // legacy rows with no source were all web
  });
});
