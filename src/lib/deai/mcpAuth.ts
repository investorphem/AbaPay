import 'server-only';
import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';

// ⚡ MCP API KEYS — the credential an AI agent (Claude, or any MCP client) presents to
// /api/mcp instead of a chat platform's user id. Unlike a PIN, this is a 256-bit random
// secret — there's nothing to brute-force, so a plain SHA-256 lookup hash is correct here
// (scrypt exists to slow down guessing a LOW-entropy secret; this key has no realistic
// guess space, and a slow hash would only cost us latency on every tool call for no
// security benefit).
//
// The raw key is shown to the user exactly once, at creation, in the AgentHub UI — it is
// never stored and can never be retrieved again, only revoked (unlink) and reissued.

const KEY_PREFIX = 'aba_mcp_';

export function generateMcpApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function hashMcpApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export interface McpIdentity {
  id: string;
  wallet_address: string;
  approved_token: string;
  approved_chain: string;
  is_active: boolean;
  link_verified: boolean;
  failed_pin_attempts: number;
  locked_until: string | null;
  pin_hash: string;
}

/** Resolve the agent_links row for a raw MCP API key, or null if it doesn't match an active link. */
export async function resolveMcpIdentity(rawKey: string): Promise<McpIdentity | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const hash = hashMcpApiKey(rawKey);
  const { data } = await supabaseAdmin
    .from('agent_links')
    .select('id, wallet_address, approved_token, approved_chain, is_active, link_verified, failed_pin_attempts, locked_until, pin_hash')
    .eq('channel', 'MCP')
    .eq('channel_user_id', hash)
    .eq('is_active', true)
    .maybeSingle();

  return (data as McpIdentity) || null;
}
