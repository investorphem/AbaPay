import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ PROVIDER CIRCUIT BREAKERS — stop selling what can't be delivered, BEFORE anyone pays.
//
// 🔴 THE INCIDENT THIS ANSWERS. From 15 Jul to 12 Aug 2026 the VTpass float was empty. Every vend
// failed with 018 ("LOW WALLET BALANCE") after the payer's crypto was already in the vault, and
// every one of them became a refund — 393 payments on 018 alone. The alert fired each time; the
// app kept taking money regardless.
//
// A breaker OPENS on the first float-exhausted answer (VTpass 018, Monnify D04). While open, the
// shared service gate (checkServiceAllowed / checkWebPayment in src/lib/serviceRules.ts) refuses
// every service that provider fulfils, on every rail — web, x402, chat, MCP, scheduler — before
// anything is signed or settled. It CLOSES when the provider's balance is back above its
// threshold (checked by src/lib/balanceAlerts.ts), or when an operator resets it.
//
// State lives in platform_settings.provider_circuits (migration 028), NOT kill_switches — see
// that migration for why. Kill switches are the operator's; breakers are the system's; a breaker
// never touches a kill switch and closing one never re-enables a service an operator turned off.

export type Provider = 'VTPASS' | 'MONNIFY';

interface CircuitState { open?: boolean; since?: string; reason?: string }

const CACHE_MS = 15_000;
let cache: { at: number; circuits: Record<string, CircuitState> } | null = null;

const enabled = () => process.env.CIRCUIT_BREAKER_ENABLED !== 'false';

/** Which provider fulfils an agent intent (the keys serviceRules.ts gates on). */
export function providerForIntent(intent: string): Provider {
  return intent === 'BANK_TRANSFER' ? 'MONNIFY' : 'VTPASS';
}

async function loadCircuits(): Promise<Record<string, CircuitState>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.circuits;
  // Its own query, deliberately: were this column added to getServiceRules' select, a deploy that
  // reached production before migration 028 would fail that whole read and fall back to rules
  // with NO kill switches at all. Here a missing column just means "no breaker is open".
  const { data, error } = await supabaseAdmin.from('platform_settings').select('provider_circuits').eq('id', 1).maybeSingle();
  const circuits = (!error && data?.provider_circuits && typeof data.provider_circuits === 'object') ? data.provider_circuits as Record<string, CircuitState> : {};
  cache = { at: Date.now(), circuits };
  return circuits;
}

/** Is this provider's breaker open (sales paused)? Fails CLOSED-to-selling: unreadable = not open. */
export async function isCircuitOpen(provider: Provider): Promise<boolean> {
  if (!enabled()) return false;
  try {
    return (await loadCircuits())[provider]?.open === true;
  } catch {
    return false;
  }
}

async function setCircuit(provider: Provider, open: boolean, reason: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('set_provider_circuit', { p_provider: provider, p_open: open, p_reason: reason });
  cache = null; // this instance sees its own change immediately; others within CACHE_MS
  if (error) {
    console.error(`[Circuit] could not ${open ? 'open' : 'close'} ${provider}:`, error.message);
    return false;
  }
  return data === true;
}

const LABEL: Record<Provider, { name: string; services: string; topUp: string }> = {
  VTPASS: { name: 'VTpass', services: 'airtime, data, electricity, cable, education and international top-ups', topUp: 'Fund the VTpass wallet' },
  MONNIFY: { name: 'Monnify (Moniepoint)', services: 'bank transfers', topUp: 'Fund the Moniepoint business account' },
};

/** Pause a provider's services because its float is exhausted. Alerts once per trip. */
export async function tripCircuit(provider: Provider, reason: string): Promise<void> {
  if (!enabled()) return;
  if (await setCircuit(provider, true, reason)) {
    const l = LABEL[provider];
    try {
      await sendTelegramAlert(
        `🛑 *${l.name.toUpperCase()} SALES PAUSED — FLOAT EXHAUSTED*\n\n${reason}\n\n` +
        `Every ${l.services} payment is now refused BEFORE the customer pays, instead of being charged and refunded.\n\n` +
        `➡️ ${l.topUp}. Sales resume automatically once the balance is back above the alert threshold — or reset it by hand from the admin API (action \`RESET_PROVIDER_CIRCUIT\`).`,
      );
    } catch { /* alerting never changes the outcome */ }
  }
}

/** Resume a provider's services. Alerts once per reset. */
export async function resetCircuit(provider: Provider, reason: string): Promise<boolean> {
  const changed = await setCircuit(provider, false, reason);
  if (changed) {
    try {
      await sendTelegramAlert(`✅ *${LABEL[provider].name.toUpperCase()} SALES RESUMED*\n\n${reason}`);
    } catch { /* ignore */ }
  }
  return changed;
}
