import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { lookupPayerIdentity } from '@/lib/payerIdentity';
import type { PayerIdentity } from '@/lib/payerIdentityTypes';

// 🔁 RE-CHECK EVERY AGENT PAYER ON CHAIN.
//
// A wallet's ERC-8004 / Self Agent ID identity (payer_identities) used to be read only when it paid,
// then cached for a day. A wallet that paid first and registered as an agent later — FIN
// (ERC-8004 #10006) paid on 2026-10-30 without naming itself — stayed "unidentified" until it paid
// again. Every wallet that has paid AbaPay's vaults through x402 or the agent relayer
// (onchain_payments, rails 'x402' and 'agent') is now re-read from the chain on a rolling basis:
// wallets never checked first, then the stalest, a batch per on-chain index run.

/** A wallet is re-read once its last check is older than this. */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
/** Wallets re-read per call; each lookup is a handful of RPC reads. */
export const RECHECK_BATCH = 20;

const PAGE = 1000;

/** Every distinct wallet that paid a vault through x402 or the relayer, lowercase. */
async function agentPayers(): Promise<string[]> {
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('onchain_payments').select('payer')
      .in('rail', ['x402', 'agent']).order('block_time', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as { payer: string }[];
    for (const r of rows) out.add(String(r.payer).toLowerCase());
    if (rows.length < PAGE) break;
  }
  return [...out];
}

/** When each wallet was last checked (missing = never). */
async function lastChecked(wallets: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < wallets.length; i += 500) {
    const { data } = await supabase.from('payer_identities').select('wallet, checked_at, lookup_error').in('wallet', wallets.slice(i, i + 500));
    for (const r of (data || []) as Pick<PayerIdentity, 'wallet' | 'checked_at' | 'lookup_error'>[]) {
      // A check that errored is treated as never done, so it's retried first.
      out.set(r.wallet, r.lookup_error ? 0 : new Date(r.checked_at).getTime());
    }
  }
  return out;
}

export interface RecheckResult {
  payers: number;
  due: number;
  checked: number;
  newly_identified: string[];
  errors: number;
}

/**
 * Re-reads up to `batch` agent payers whose identity is missing or older than `staleMs`, oldest
 * first, and stores what the chain says. Reports the wallets that gained an ERC-8004 or Self
 * identity they didn't have before, so the caller can log them.
 */
export async function recheckAgentPayers(opts: { batch?: number; staleMs?: number; now?: number; deadline?: number } = {}): Promise<RecheckResult> {
  const batch = opts.batch ?? RECHECK_BATCH;
  const staleMs = opts.staleMs ?? RECHECK_AFTER_MS;
  const now = opts.now ?? Date.now();

  const payers = await agentPayers();
  const checked = await lastChecked(payers);
  const due = payers
    .map((w) => ({ w, at: checked.get(w) ?? -1 }))
    .filter((x) => now - x.at >= staleMs)
    .sort((a, b) => a.at - b.at);

  const result: RecheckResult = { payers: payers.length, due: due.length, checked: 0, newly_identified: [], errors: 0 };
  for (const { w } of due.slice(0, batch)) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const { data: before } = await supabase.from('payer_identities').select('erc8004_agents, self_verified').eq('wallet', w).maybeSingle();
      const identity = await lookupPayerIdentity(w);
      const { error } = await supabase.from('payer_identities').upsert(identity, { onConflict: 'wallet' });
      if (error) throw new Error(error.message);
      result.checked++;
      const had = ((before as Pick<PayerIdentity, 'erc8004_agents'> | null)?.erc8004_agents ?? []).length > 0 || (before as Pick<PayerIdentity, 'self_verified'> | null)?.self_verified === true;
      const has = identity.erc8004_agents.length > 0 || identity.self_verified === true;
      if (has && !had) result.newly_identified.push(w);
    } catch (e) {
      result.errors++;
      console.warn('[payerRecheck]', w, e instanceof Error ? e.message : e);
    }
  }
  return result;
}
