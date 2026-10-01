import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';
import { getWalletBalance } from '@/lib/monnify';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { supabaseAdmin } from '@/utils/supabase';
import { metric } from '@/lib/log';

// 🩺 ADMIN HEALTH (M5). Admin only.
//
// Keeps the provider balances the dashboard has always shown (naira, sms, monnify), and adds
// `components`: a per-part status for what actually breaks payments, each `ok | warn | down`
// with the number behind it, so a glance tells you WHERE it's broken, not just that it is.
// Every number is also emitted as a gauge metric so a log drain can graph and alert on it.

type Status = 'ok' | 'warn' | 'down';
interface Component { status: Status; value?: number | string | null; detail?: string }

const STUCK_PROCESSING_MINUTES = 30;
const X402_UNRESOLVED_MINUTES = 15;
const REFUND_WARN_HOURS = 72;

const countQuery = () => supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true });
type CountQuery = ReturnType<typeof countQuery>;

async function countSince(filter: (q: CountQuery) => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count, error } = await filter(countQuery());
  return error ? null : count ?? 0;
}

async function components(): Promise<Record<string, Component>> {
  const out: Record<string, Component> = {};
  const now = Date.now();

  // Database reachable at all.
  const { data: settings, error: dbErr } = await supabaseAdmin.from('platform_settings').select('provider_circuits').eq('id', 1).maybeSingle();
  out.database = dbErr ? { status: 'down', detail: dbErr.message } : { status: 'ok' };
  if (dbErr) return out;

  // Refund backlog: how many, and how long the oldest has waited.
  const { data: oldest, count: pending } = await supabaseAdmin
    .from('refund_queue').select('created_at', { count: 'exact' }).eq('status', 'PENDING')
    .order('created_at', { ascending: true }).limit(1);
  const ageHours = oldest?.[0]?.created_at ? (now - new Date(oldest[0].created_at).getTime()) / 3600_000 : 0;
  metric('refunds_pending', pending ?? 0);
  metric('refund_age_max_hours', Math.round(ageHours * 10) / 10);
  out.refunds = {
    status: !pending ? 'ok' : ageHours > REFUND_WARN_HOURS ? 'warn' : 'ok',
    value: pending ?? 0,
    detail: pending ? `oldest waiting ${Math.round(ageHours)}h` : 'none pending',
  };

  // Paid, delivery outcome still unknown (PROCESSING past the reconciler's window).
  const stuck = await countSince((q) => q.eq('status', 'PROCESSING').lt('created_at', new Date(now - STUCK_PROCESSING_MINUTES * 60_000).toISOString()));
  metric('unknown_outcome_rows', stuck ?? -1);
  out.unknown_outcomes = { status: stuck == null ? 'warn' : stuck > 0 ? 'warn' : 'ok', value: stuck, detail: `PROCESSING > ${STUCK_PROCESSING_MINUTES} min` };

  // x402 intents recorded but neither settled nor closed.
  const x402 = await countSince((q) => q.like('tx_hash', 'preflight_x402_%').eq('status', 'PENDING').lt('created_at', new Date(now - X402_UNRESOLVED_MINUTES * 60_000).toISOString()));
  metric('x402_intents_unresolved', x402 ?? -1);
  out.x402_intents = { status: x402 == null ? 'warn' : x402 > 0 ? 'warn' : 'ok', value: x402, detail: `unresolved > ${X402_UNRESOLVED_MINUTES} min` };

  // Provider breakers (migration 028): an open one means that provider's sales are paused.
  const circuits = ((settings as { provider_circuits?: unknown } | null)?.provider_circuits || {}) as Record<string, { open?: boolean; reason?: string }>;
  const open = Object.entries(circuits).filter(([, c]) => c?.open).map(([p, c]) => `${p}: ${c.reason || 'open'}`);
  out.provider_circuits = { status: open.length ? 'down' : 'ok', value: open.length, detail: open.length ? open.join('; ') : 'all closed' };

  return out;
}

export async function GET(req: Request) {
  // 🔐 Wallet balances and operational state are for the admin's eyes only.
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
  }

  try {
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
    const baseUrl = appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';

    const [walletData, smsBalance, monnifyBalance, parts] = await Promise.all([
      fetch(`${baseUrl}/balance`, { method: 'GET', headers: getHeaders() }).then((r) => r.json()).catch(() => null),
      fetch('https://messaging.vtpass.com/api/sms/balance', {
        method: 'GET',
        headers: { 'X-Token': process.env.VTPASS_MSG_TOKEN || '', 'X-Secret': process.env.VTPASS_MSG_SECRET || '' },
      }).then((r) => r.text()).catch(() => ''),
      // null (not thrown) when Monnify credentials aren't configured.
      getWalletBalance().catch(() => null),
      components().catch((err): Record<string, Component> => ({ database: { status: 'down', detail: err instanceof Error ? err.message : String(err) } })),
    ]);

    const vtBalance = walletData?.contents?.balance;
    parts.vtpass = vtBalance == null ? { status: 'warn', detail: 'balance unreadable' } : { status: 'ok', value: Number(vtBalance) };
    const worst: Status = Object.values(parts).some((c) => c.status === 'down') ? 'down'
      : Object.values(parts).some((c) => c.status === 'warn') ? 'warn' : 'ok';

    return NextResponse.json({
      env: appMode,
      chain: process.env.NEXT_PUBLIC_NETWORK || 'Unknown',
      naira: vtBalance?.toLocaleString() || '0.00',
      sms: !isNaN(parseFloat(smsBalance)) ? parseFloat(smsBalance).toFixed(0) : '0',
      monnify: monnifyBalance ? {
        available: monnifyBalance.availableBalance.toLocaleString(),
        ledger: monnifyBalance.ledgerBalance.toLocaleString(),
        accountNumber: monnifyBalance.accountNumber,
      } : null,
      status: worst === 'ok' ? 'Operational' : worst === 'warn' ? 'Degraded' : 'Down',
      overall: worst,
      components: parts,
    });
  } catch (err) {
    console.error('Health Check Failed:', err);
    return NextResponse.json({ status: 'Error', msg: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
