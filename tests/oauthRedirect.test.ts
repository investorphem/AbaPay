import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ supabaseAdmin: {} }));
const { isAllowedRedirectUri } = await import('@/lib/deai/mcpOAuth');

// Which redirect URIs an MCP OAuth client may register (Dynamic Client Registration).

describe('isAllowedRedirectUri', () => {
  it('allows https anywhere', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('allows plain http only on loopback (desktop clients, incl. newer Cursor)', () => {
    expect(isAllowedRedirectUri('http://localhost:8787/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:33418/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.example.com/cb')).toBe(false);
  });

  it("allows Cursor's exact native callback, so OAuth works in Cursor <= 3.14", () => {
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true);
  });

  it('refuses every other custom scheme, and look-alikes of the Cursor one', () => {
    for (const uri of [
      'cursor://anysphere.cursor-mcp/oauth/callback/../steal',
      'cursor://attacker/oauth/callback',
      'cursor://anysphere.cursor-mcp/oauth/callback?x=1',
      'myapp://callback',
      'javascript:alert(1)',
      'data:text/html,hi',
      'not a url',
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(false);
    }
  });
});
