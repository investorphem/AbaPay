import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import type { PayerIdentity } from '@/lib/payerIdentityTypes';

// 📊 EXTERNAL-AGENT PAYMENTS REPORT — Prezenti grant milestone 1 (S3-F-007, Attachment A).
//
// THE CHAIN IS THE JUDGE. The payments counted are the Celo vault payments the on-chain indexer
// recorded (onchain_payments, src/lib/onchain/indexer.ts) inside the window: amount, token, payer,
// vault and time all come from the chain, whether or not AbaPay's own database has an order for
// them. The database only adds context:
//   • who the agent is (payment_client_info's declared name/ID, payer_identities' ERC-8004 / Self),
//   • which AbaPay channel made it, so the agreement's exclusions can be applied:
//       excluded  AbaPay's own web app (x402 'WEB'), its own Telegram/WhatsApp/X agent and
//                 schedules (relayer rows not from MCP/A2A), orders that weren't delivered
//                 (refunded/failed), and any wallet on the exclusion list (GRANT_EXCLUDED_WALLETS
//                 plus the admin, relayer and server wallets);
//   • an x402 payment with no AbaPay order still counts — it is on chain — flagged onchain_only.
//     A relayer ('agent' rail) payment with no order can't be told apart from AbaPay's own chat
//     agent, so it is listed as excluded rather than guessed.
// Agents: only payers we can name (ERC-8004, a declared name, an OAuth client) count as agents;
// unnamed payers are grouped, never one "agent" per wallet.
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
  /** On chain, but AbaPay has no order for it. */
  onchain_only: boolean;
}

export interface GrantAgent {
  agent: string;
  /** False for the grouped bucket of payers we can't name. */
  identified: boolean;
  integrations: string[];
  erc8004_id: string | null;
  self_agent: string | null;
  payments: number;
  wallets: number;
  volume_usd: number;
  first_tx: string;
}

export interface GrantExclusions {
  excluded_wallet: number;
  abapay_web_app_or_own_agent: number;
  not_delivered: number;
  relayer_without_order: number;
}

export interface GrantReport {
  from: string;
  to: string;
  source: 'onchain';
  /** When the Celo indexer last ran, and the block it had reached. */
  indexed: { block: number | null; at: string | null };
  /** Every Celo x402/relayer payment into the vaults in the window, before exclusions. */
  onchain_total: { payments: number; volume_usd: number };
  totals: { payments: number; wallets: number; volume_usd: number; agents: number };
  breakdown: { recorded: number; onchain_only: number; unidentified_payments: number };
  excluded: GrantExclusions;
  targets: typeof GRANT_TARGETS;
  met: { payments: boolean; wallets: boolean; volume: boolean; agents: boolean };
  agents: GrantAgent[];
  payments: GrantPayment[];
  excluded_wallets: number;
}

const lower = (s: unknown) => String(s || '').trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

export function excludedWallets(): Set<string> {
  const list = [
    ...String(process.env.GRANT_EXCLUDED_WALLETS || '').split(','),
    process.env.ADMIN_WALLET_ADDRESS, ...String(process.env.ADMIN_WALLET_ADDRESSES || '').split(','),
    process.env.RELAYER_ADDRESS, process.env.THIRDWEB_SERVER_WALLET_ADDRESS, process.env.ABAPAY_OWNER,
  ];
  return new Set(list.map(lower).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
}

type OnchainRow = {
  tx_hash: string; log_index: number; block_time: string; contract: string; payer: string;
  token_symbol: string; amount_usd: number | string; rail: 'direct' | 'agent' | 'x402';
};
type TxRow = {
  id: string; status: string; tx_hash: string; x402_settle_tx: string | null; request_id: string | null;
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

/** AbaPay's order for each on-chain hash, by tx_hash or (x402) x402_settle_tx. */
async function ordersByHash(hashes: string[]): Promise<Map<string, TxRow>> {
  const out = new Map<string, TxRow>();
  const cols = 'id, status, tx_hash, x402_settle_tx, request_id, payment_method, source_channel, service_category, network';
  for (let i = 0; i < hashes.length; i += 300) {
    const chunk = hashes.slice(i, i + 300);
    const [a, b] = await Promise.all([
      supabase.from('transactions').select(cols).in('tx_hash', chunk),
      supabase.from('transactions').select(cols).in('x402_settle_tx', chunk),
    ]);
    for (const r of [...((a.data || []) as TxRow[]), ...((b.data || []) as TxRow[])]) {
      for (const h of [lower(r.tx_hash), lower(r.x402_settle_tx)]) if (h && !out.has(h)) out.set(h, r);
    }
  }
  return out;
}

export async function buildGrantReport(fromIso: string, toIso: string): Promise<GrantReport> {
  const onchain = await pagedRows<OnchainRow>((a, b) => supabase.from('onchain_payments')
    .select('tx_hash, log_index, block_time, contract, payer, token_symbol, amount_usd, rail')
    .eq('chain', 'CELO').in('rail', ['x402', 'agent'])
    .gte('block_time', fromIso).lt('block_time', toIso)
    .order('block_time', { ascending: true }).range(a, b));

  const hashes = [...new Set(onchain.map((r) => lower(r.tx_hash)))];
  const orders = await ordersByHash(hashes);

  const orderIds = [...new Set([...orders.values()].map((o) => o.id))];
  const clients = new Map<string, ClientRow>();
  for (let i = 0; i < orderIds.length; i += 500) {
    const { data } = await supabase.from('payment_client_info').select('transaction_id, declared_agent, declared_agent_id, client_diag').in('transaction_id', orderIds.slice(i, i + 500));
    for (const c of (data || []) as ClientRow[]) clients.set(c.transaction_id, c);
  }
  const wallets = [...new Set(onchain.map((r) => lower(r.payer)))];
  const identities = new Map<string, PayerIdentity>();
  for (let i = 0; i < wallets.length; i += 500) {
    const { data } = await supabase.from('payer_identities').select('*').in('wallet', wallets.slice(i, i + 500));
    for (const p of (data || []) as PayerIdentity[]) identities.set(p.wallet, p);
  }
  const { data: cursor } = await supabase.from('onchain_cursors').select('last_block, updated_at').eq('chain', 'CELO').maybeSingle();

  const excludedSet = excludedWallets();
  const excluded: GrantExclusions = { excluded_wallet: 0, abapay_web_app_or_own_agent: 0, not_delivered: 0, relayer_without_order: 0 };
  const payments: GrantPayment[] = [];
  const unidentified = new Set<number>();

  for (const r of onchain) {
    const hash = lower(r.tx_hash);
    const sender = lower(r.payer);
    if (excludedSet.has(sender)) { excluded.excluded_wallet++; continue; }

    const order = orders.get(hash);
    const client = order ? clients.get(order.id) : undefined;
    const diag = client?.client_diag || null;
    let integration: GrantPayment['integration'];
    if (order) {
      if (order.status !== 'SUCCESS') { excluded.not_delivered++; continue; }
      const rail = externalRail(order, diag);
      if (!rail) { excluded.abapay_web_app_or_own_agent++; continue; }
      integration = rail;
    } else if (r.rail === 'x402') {
      integration = 'x402';
    } else {
      excluded.relayer_without_order++; continue;
    }

    const identity = identities.get(sender);
    const erc = identity?.erc8004_agents?.[0];
    const selfSigned = diag?.self_agent && typeof diag.self_agent === 'object' ? diag.self_agent as { status?: string; agent_id?: string } : null;
    const selfAgent = selfSigned?.status === 'verified' ? `verified #${selfSigned.agent_id}`
      : identity?.self_verified ? `verified #${identity.self_agent_id ?? '?'} (wallet)` : null;
    const named = erc ? `${erc.name || 'Agent'} (ERC-8004 #${erc.id})`
      : client?.declared_agent || (typeof diag?.oauth_client_name === 'string' ? `${diag.oauth_client_name} (OAuth client)` : '');
    const agent = named || (order ? `Unidentified ${integration} payers` : 'Unidentified x402 payers (no AbaPay order)');
    if (!named) unidentified.add(payments.length);

    payments.push({
      tx_hash: hash, date: r.block_time, token: r.token_symbol, amount: Number(r.amount_usd) || 0,
      sender, recipient: lower(r.contract), agent, integration,
      erc8004_id: erc?.id ?? client?.declared_agent_id ?? null, self_agent: selfAgent,
      service: order ? `${order.network || ''} ${order.service_category || ''}`.trim() : '',
      request_id: order?.request_id ?? null, onchain_only: !order,
    });
  }

  const byAgent = new Map<string, GrantAgent & { _wallets: Set<string>; _int: Set<string> }>();
  payments.forEach((p, i) => {
    const a = byAgent.get(p.agent) || { agent: p.agent, identified: !unidentified.has(i), integrations: [], erc8004_id: p.erc8004_id, self_agent: p.self_agent, payments: 0, wallets: 0, volume_usd: 0, first_tx: p.tx_hash, _wallets: new Set(), _int: new Set() };
    a.payments++; a.volume_usd += p.amount; a._wallets.add(p.sender); a._int.add(p.integration);
    a.self_agent = a.self_agent || p.self_agent; a.erc8004_id = a.erc8004_id || p.erc8004_id;
    byAgent.set(p.agent, a);
  });
  const agents = [...byAgent.values()].map(({ _wallets, _int, ...a }) => ({ ...a, wallets: _wallets.size, integrations: [..._int], volume_usd: round2(a.volume_usd) }))
    .sort((x, y) => Number(y.identified) - Number(x.identified) || y.payments - x.payments);

  const identifiedAgents = agents.filter((a) => a.identified).length;
  const volume = round2(payments.reduce((s, p) => s + p.amount, 0));
  const walletCount = new Set(payments.map((p) => p.sender)).size;
  return {
    from: fromIso, to: toIso, source: 'onchain',
    indexed: { block: cursor?.last_block != null ? Number(cursor.last_block) : null, at: cursor?.updated_at ?? null },
    onchain_total: { payments: onchain.length, volume_usd: round2(onchain.reduce((s, r) => s + (Number(r.amount_usd) || 0), 0)) },
    totals: { payments: payments.length, wallets: walletCount, volume_usd: volume, agents: identifiedAgents },
    breakdown: {
      recorded: payments.filter((p) => !p.onchain_only).length,
      onchain_only: payments.filter((p) => p.onchain_only).length,
      unidentified_payments: unidentified.size,
    },
    excluded,
    targets: GRANT_TARGETS,
    met: { payments: payments.length >= GRANT_TARGETS.payments, wallets: walletCount >= GRANT_TARGETS.wallets, volume: volume >= GRANT_TARGETS.volumeUsd, agents: identifiedAgents >= GRANT_TARGETS.agents },
    agents, payments, excluded_wallets: excludedSet.size,
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The CSV the final report attaches: one row per counted payment, every figure from the chain. */
export function grantReportCsv(report: GrantReport): string {
  const head = ['tx_hash', 'date', 'token', 'amount', 'sender', 'recipient', 'agent', 'integration', 'erc8004_id', 'self_agent', 'service', 'abapay_order', 'celoscan'];
  const lines = report.payments.map((p) => [p.tx_hash, p.date, p.token, p.amount, p.sender, p.recipient, p.agent, p.integration, p.erc8004_id, p.self_agent, p.service, p.onchain_only ? 'no' : 'yes', `https://celoscan.io/tx/${p.tx_hash}`].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
