import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { vaultAddressFor } from '@/lib/paymentProof';
import type { PayerIdentity } from '@/lib/payerIdentityTypes';

// 📊 EXTERNAL-AGENT PAYMENTS REPORT — Prezenti grant milestone 1 (S3-F-007, Attachment A).
//
// Counts, inside one window, the successful Celo payments that EXTERNAL agents and apps made
// through AbaPay's agent rails, exactly as the agreement defines them:
//   counted:  x402 from an agent (source_channel 'AGENT'), and MCP/A2A agents through the agent
//             relayer (payment_method 'AGENT_RELAY', source_channel 'MCP'/'A2A');
//   excluded: AbaPay's own web app (x402 'WEB'), AbaPay's own Telegram/WhatsApp/X agent and
//             schedules, anything not SUCCESS (refunded, failed, pending), and any wallet on the
//             exclusion list (AbaPay-controlled and test wallets: GRANT_EXCLUDED_WALLETS plus the
//             admin, relayer and server wallets).
// Targets: ≥5 agents/apps, ≥1,000 payments, ≥25 unique paying wallets, ≥$1,000 volume.

export const GRANT_TARGETS = { agents: 5, payments: 1000, wallets: 25, volumeUsd: 1000 } as const;

export interface GrantPayment {
  tx_hash: string;
  date: string;
  token: string;
  amount: number;
  sender: string;
  recipient: string;
  agent: string;
  integration: 'x402' | 'MCP' | 'A2A';
  erc8004_id: string | null;
  self_agent: string | null;
  service: string;
  request_id: string | null;
}

export interface GrantAgent {
  agent: string;
  integrations: string[];
  erc8004_id: string | null;
  self_agent: string | null;
  payments: number;
  wallets: number;
  volume_usd: number;
  first_tx: string;
}

export interface GrantReport {
  from: string;
  to: string;
  totals: { payments: number; wallets: number; volume_usd: number; agents: number };
  targets: typeof GRANT_TARGETS;
  met: { payments: boolean; wallets: boolean; volume: boolean; agents: boolean };
  agents: GrantAgent[];
  payments: GrantPayment[];
  excluded_wallets: number;
}

const lower = (s: unknown) => String(s || '').trim().toLowerCase();

export function excludedWallets(): Set<string> {
  const list = [
    ...String(process.env.GRANT_EXCLUDED_WALLETS || '').split(','),
    process.env.ADMIN_WALLET_ADDRESS, ...String(process.env.ADMIN_WALLET_ADDRESSES || '').split(','),
    process.env.RELAYER_ADDRESS, process.env.THIRDWEB_SERVER_WALLET_ADDRESS, process.env.ABAPAY_OWNER,
  ];
  return new Set(list.map(lower).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
}

type TxRow = {
  id: string; created_at: string; status: string; tx_hash: string; request_id: string | null;
  wallet_address: string | null; x402_payer?: string | null; token_used: string | null; amount_usdt: number | string | null;
  payment_method: string | null; source_channel: string | null; service_category: string | null; network: string | null;
};
type ClientRow = { transaction_id: string; declared_agent: string | null; declared_agent_id: string | null; client_diag: Record<string, unknown> | null };

/** Which agent rail a row came through, or null when it isn't an external-agent payment. */
export function externalRail(t: Pick<TxRow, 'payment_method' | 'source_channel'>, diag?: Record<string, unknown> | null): GrantPayment['integration'] | null {
  const method = String(t.payment_method || '').toUpperCase();
  const src = String(t.source_channel || '').toUpperCase();
  if (method === 'X402') return src === 'AGENT' ? 'x402' : null;
  if (method === 'AGENT_RELAY' && (src === 'MCP' || src === 'A2A')) {
    return String(diag?.protocol || src).toUpperCase() === 'A2A' ? 'A2A' : 'MCP';
  }
  return null;
}

async function pagedRows<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data as T[]) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function buildGrantReport(fromIso: string, toIso: string): Promise<GrantReport> {
  const rows = await pagedRows<TxRow>((a, b) => supabase.from('transactions')
    .select('id, created_at, status, tx_hash, request_id, wallet_address, x402_payer, token_used, amount_usdt, payment_method, source_channel, service_category, network')
    .eq('blockchain', 'CELO').eq('status', 'SUCCESS')
    .in('payment_method', ['X402', 'AGENT_RELAY'])
    .gte('created_at', fromIso).lt('created_at', toIso)
    .order('created_at', { ascending: true }).range(a, b));

  const ids = rows.map((r) => r.id);
  const clients = new Map<string, ClientRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await supabase.from('payment_client_info').select('transaction_id, declared_agent, declared_agent_id, client_diag').in('transaction_id', ids.slice(i, i + 500));
    for (const c of (data || []) as ClientRow[]) clients.set(c.transaction_id, c);
  }
  const wallets = [...new Set(rows.map((r) => lower(r.x402_payer || r.wallet_address)).filter(Boolean))];
  const identities = new Map<string, PayerIdentity>();
  for (let i = 0; i < wallets.length; i += 500) {
    const { data } = await supabase.from('payer_identities').select('*').in('wallet', wallets.slice(i, i + 500));
    for (const p of (data || []) as PayerIdentity[]) identities.set(p.wallet, p);
  }

  const excluded = excludedWallets();
  const recipient = vaultAddressFor('CELO') || '';
  const payments: GrantPayment[] = [];
  for (const r of rows) {
    const client = clients.get(r.id);
    const diag = client?.client_diag || null;
    const integration = externalRail(r, diag);
    if (!integration) continue;
    const sender = lower(r.x402_payer || r.wallet_address);
    if (!sender || excluded.has(sender)) continue;
    if (!/^0x[0-9a-f]{64}$/i.test(String(r.tx_hash || ''))) continue; // only on-chain, verifiable payments

    const identity = identities.get(sender);
    const erc = identity?.erc8004_agents?.[0];
    const selfSigned = diag?.self_agent && typeof diag.self_agent === 'object' ? diag.self_agent as { status?: string; agent_id?: string } : null;
    const selfAgent = selfSigned?.status === 'verified' ? `verified #${selfSigned.agent_id}`
      : identity?.self_verified ? `verified #${identity.self_agent_id ?? '?'} (wallet)` : null;
    const agent = erc ? `${erc.name || 'Agent'} (ERC-8004 #${erc.id})`
      : client?.declared_agent || (typeof diag?.oauth_client_name === 'string' ? `${diag.oauth_client_name} (OAuth client)` : '')
      || `Unidentified ${integration} agent ${sender.slice(0, 6)}…${sender.slice(-4)}`;

    payments.push({
      tx_hash: String(r.tx_hash).toLowerCase(), date: r.created_at, token: r.token_used || 'USDC',
      amount: Number(r.amount_usdt) || 0, sender, recipient, agent, integration,
      erc8004_id: erc?.id ?? client?.declared_agent_id ?? null, self_agent: selfAgent,
      service: `${r.network || ''} ${r.service_category || ''}`.trim(), request_id: r.request_id,
    });
  }

  const byAgent = new Map<string, GrantAgent & { _wallets: Set<string>; _int: Set<string> }>();
  for (const p of payments) {
    const a = byAgent.get(p.agent) || { agent: p.agent, integrations: [], erc8004_id: p.erc8004_id, self_agent: p.self_agent, payments: 0, wallets: 0, volume_usd: 0, first_tx: p.tx_hash, _wallets: new Set(), _int: new Set() };
    a.payments++; a.volume_usd += p.amount; a._wallets.add(p.sender); a._int.add(p.integration);
    a.self_agent = a.self_agent || p.self_agent; a.erc8004_id = a.erc8004_id || p.erc8004_id;
    byAgent.set(p.agent, a);
  }
  const agents = [...byAgent.values()].map(({ _wallets, _int, ...a }) => ({ ...a, wallets: _wallets.size, integrations: [..._int], volume_usd: Math.round(a.volume_usd * 100) / 100 }))
    .sort((x, y) => y.payments - x.payments);

  const volume = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  const walletCount = new Set(payments.map((p) => p.sender)).size;
  return {
    from: fromIso, to: toIso,
    totals: { payments: payments.length, wallets: walletCount, volume_usd: volume, agents: agents.length },
    targets: GRANT_TARGETS,
    met: { payments: payments.length >= GRANT_TARGETS.payments, wallets: walletCount >= GRANT_TARGETS.wallets, volume: volume >= GRANT_TARGETS.volumeUsd, agents: agents.length >= GRANT_TARGETS.agents },
    agents, payments, excluded_wallets: excluded.size,
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The CSV the final report attaches: one row per counted payment. */
export function grantReportCsv(report: GrantReport): string {
  const head = ['tx_hash', 'date', 'token', 'amount', 'sender', 'recipient', 'agent', 'integration', 'erc8004_id', 'self_agent', 'service', 'celoscan'];
  const lines = report.payments.map((p) => [p.tx_hash, p.date, p.token, p.amount, p.sender, p.recipient, p.agent, p.integration, p.erc8004_id, p.self_agent, p.service, `https://celoscan.io/tx/${p.tx_hash}`].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
