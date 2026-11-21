import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { lookupPayerIdentity } from '@/lib/payerIdentity';
import { excludedWallets } from '@/lib/grantReport';
import type { PayerIdentity } from '@/lib/payerIdentityTypes';

// 🔁 RE-CHECK EVERY AGENT PAYER ON CHAIN.
//
// A wallet's ERC-8004 / Self Agent ID identity (payer_identities) used to be read only when it paid,
// then cached for a day. A wallet that paid first and registered as an agent later — FIN
// (ERC-8004 #10006) paid on 2026-10-30 without naming itself — stayed "unidentified" until it paid
// again. Every wallet that has paid AbaPay's vaults (onchain_payments, every rail) is re-read from
// the chain on a rolling basis: wallets never checked first, then the stalest, a batch per on-chain
// index run. Every rail, not only x402 and the relayer, since 2026-11-21: an agent wallet can also
// pay in the web app, and once it is registered it counts as an agent wallet wherever it paid
// (src/lib/grantReport.ts).

/** A wallet is re-read once its last check is older than this. */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
/** Wallets re-read per call; each lookup is a handful of RPC reads. */
export const RECHECK_BATCH = 20;

const PAGE = 1000;

/** Every distinct wallet that paid a vault, on any rail, lowercase. */
async function agentPayers(): Promise<string[]> {
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('onchain_payments').select('payer')
      .order('block_time', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data || []) as { payer: string }[];
    for (const r of rows) out.add(String(r.payer).toLowerCase());
    if (rows.length < PAGE) break;
  }
  return [...out];
}

/** Wallets per `in` filter. Each is 42 characters in the request URL; 500 of them (~21 KB) made the
 * request too long, it failed without a word, every wallet read as never checked, and every run
 * re-read the same first 20 wallets forever while the rest were never looked at again. */
const LOOKUP_CHUNK = 100;

/** When each wallet was last checked (missing = never). Throws if a page can't be read. */
async function lastChecked(wallets: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < wallets.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase.from('payer_identities').select('wallet, checked_at, lookup_error').in('wallet', wallets.slice(i, i + LOOKUP_CHUNK));
    if (error) throw new Error(`payer_identities read failed: ${error.message}`);
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

  const excluded = excludedWallets();
  const result: RecheckResult = { payers: payers.length, due: due.length, checked: 0, newly_identified: [], errors: 0 };
  for (const { w } of due.slice(0, batch)) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const { data } = await supabase.from('payer_identities').select('erc8004_agents, self_verified, lookup_error').eq('wallet', w).maybeSingle();
      const before = data as Pick<PayerIdentity, 'erc8004_agents' | 'self_verified' | 'lookup_error'> | null;
      const identity = await lookupPayerIdentity(w);
      const had = (before?.erc8004_agents ?? []).length > 0 || before?.self_verified === true;
      const has = identity.erc8004_agents.length > 0 || identity.self_verified === true;
      // A lookup that half-failed must not wipe an identity we already know: that is what would make
      // the same wallet look "newly identified" again on the next clean read.
      if (identity.lookup_error && had && !has) throw new Error(`lookup failed, kept the known identity: ${identity.lookup_error}`);
      const { error } = await supabase.from('payer_identities').upsert(identity, { onConflict: 'wallet' });
      if (error) throw new Error(error.message);
      result.checked++;
      // Alert once, only for a real change: the wallet was read cleanly before with no identity and
      // now has one. A first-ever read (no earlier row) is not "newly" anything — it is just being
      // looked at — and AbaPay's own / excluded wallets are never news.
      const changed = !!before && !before.lookup_error && !had && has && !identity.lookup_error;
      if (changed && !excluded.has(w)) result.newly_identified.push(w);
    } catch (e) {
      result.errors++;
      console.warn('[payerRecheck]', w, e instanceof Error ? e.message : e);
    }
  }
  return result;
}
