import 'server-only';
import { getHeaders } from '@/lib/vtpass';
import { getWalletBalance } from '@/lib/monnify';
import { sendTelegramAlert } from '@/lib/telegram';

// ⚡ LOW-BALANCE ALERTING — proactive, not reactive.
//
// Before this, the ONLY signal a depleted float gave was a failed vend: VTpass rejects a
// payment with "LOW WALLET BALANCE" (error 018) or a Monnify transfer fails for the same
// reason — AFTER a user's crypto has already landed in the vault. That means the first sign
// of a low float is always a user-facing failure + an automatic refund, never a heads-up
// before it happens. This checks both providers' float directly and warns the operator while
// there's still time to top up.
//
// Cooldown per provider (not a single shared one) so a genuinely low VTpass balance doesn't
// get silenced by Monnify refreshing its own timer, or vice versa.

const VTPASS_THRESHOLD_NGN = Number(process.env.VTPASS_LOW_BALANCE_THRESHOLD_NGN) || 5_000;
const MONNIFY_THRESHOLD_NGN = Number(process.env.MONNIFY_LOW_BALANCE_THRESHOLD_NGN) || 5_000;
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-alert at most once per 6h per provider while still low

const lastAlertedAt: Record<'VTPASS' | 'MONNIFY', number> = { VTPASS: 0, MONNIFY: 0 };

async function getVtpassBalance(): Promise<number | null> {
  try {
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
    const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
    const res = await fetch(`${baseUrl}/balance`, { method: 'GET', headers: getHeaders(), signal: AbortSignal.timeout(8_000) });
    const data = await res.json();
    const balance = Number(data?.contents?.balance);
    return Number.isFinite(balance) ? balance : null;
  } catch (e) {
    console.error('[BalanceAlerts] VTpass balance check failed:', (e as Error).message);
    return null;
  }
}

export async function checkProviderBalances(opts: { force?: boolean } = {}) {
  const now = Date.now();
  const results: { provider: string; balance: number | null; alerted: boolean }[] = [];

  const vtpassBalance = await getVtpassBalance();
  if (vtpassBalance !== null && vtpassBalance < VTPASS_THRESHOLD_NGN) {
    if (opts.force || now - lastAlertedAt.VTPASS > COOLDOWN_MS) {
      await sendTelegramAlert(
        `⚠️ *VTPASS BALANCE LOW*\n\nCurrent balance: ₦${vtpassBalance.toLocaleString()} (threshold: ₦${VTPASS_THRESHOLD_NGN.toLocaleString()})\n\nFund the VTpass wallet soon — vends will start failing with "LOW WALLET BALANCE" once it runs dry, triggering automatic refunds for anyone caught by it.`
      );
      lastAlertedAt.VTPASS = now;
      results.push({ provider: 'VTPASS', balance: vtpassBalance, alerted: true });
    } else {
      results.push({ provider: 'VTPASS', balance: vtpassBalance, alerted: false });
    }
  } else {
    results.push({ provider: 'VTPASS', balance: vtpassBalance, alerted: false });
  }

  const monnifyBalance = await getWalletBalance();
  if (monnifyBalance !== null && monnifyBalance.availableBalance < MONNIFY_THRESHOLD_NGN) {
    if (opts.force || now - lastAlertedAt.MONNIFY > COOLDOWN_MS) {
      await sendTelegramAlert(
        `⚠️ *MONNIFY (MONIEPOINT) BALANCE LOW*\n\nAvailable balance: ₦${monnifyBalance.availableBalance.toLocaleString()} (threshold: ₦${MONNIFY_THRESHOLD_NGN.toLocaleString()})\n\nFund the Moniepoint business account soon — bank transfers will start failing once it runs dry, triggering automatic refunds for anyone caught by it.`
      );
      lastAlertedAt.MONNIFY = now;
      results.push({ provider: 'MONNIFY', balance: monnifyBalance.availableBalance, alerted: true });
    } else {
      results.push({ provider: 'MONNIFY', balance: monnifyBalance.availableBalance, alerted: false });
    }
  } else {
    results.push({ provider: 'MONNIFY', balance: monnifyBalance?.availableBalance ?? null, alerted: false });
  }

  return { ok: true, results };
}
