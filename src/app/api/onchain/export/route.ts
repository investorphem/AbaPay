import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { ONCHAIN_CHAINS, type OnchainChain } from '@/lib/onchain/config';

// CSV of every indexed payment on one chain (?chain=CELO or BASE) or both (?chain=ALL), so anyone
// can check the numbers on stats.abapays.com against the chain themselves: each row carries its transaction hash and an explorer link.
// Everything in it is already public on-chain; no customer data is stored in the table at all.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COLUMNS = 'chain, block_time, tx_hash, log_index, block_number, contract, contract_label, payer, token_symbol, amount_usd, rail, service_type, tags';

const csvCell = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export async function GET(req: Request) {
  const chain = (new URL(req.url).searchParams.get('chain') || 'CELO').toUpperCase();
  if (chain !== 'CELO' && chain !== 'BASE' && chain !== 'ALL') return new Response('chain must be CELO, BASE or ALL', { status: 400 });

  const lines = [`${COLUMNS.replaceAll(' ', '')},explorer_url`];
  // PostgREST caps a response at 1,000 rows, so page through.
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin.from('onchain_payments').select(COLUMNS);
    if (chain !== 'ALL') q = q.eq('chain', chain);
    const { data, error } = await q
      // The full primary key after the time, so the order is total and no row is skipped or
      // repeated across pages when several payments share a block.
      .order('block_time', { ascending: false })
      .order('chain', { ascending: true })
      .order('tx_hash', { ascending: true })
      .order('log_index', { ascending: true })
      .range(from, from + 999);
    if (error) return new Response('Could not read the index right now.', { status: 503 });
    for (const r of data as Record<string, unknown>[]) {
      lines.push([...COLUMNS.split(', ').map((c) => csvCell(r[c])), `${ONCHAIN_CHAINS[r.chain as OnchainChain].explorer}/tx/${r.tx_hash}`].join(','));
    }
    if (data.length < 1000) break;
  }

  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="abapay-${chain.toLowerCase()}-payments.csv"`,
      'cache-control': 'public, s-maxage=600, stale-while-revalidate=600',
    },
  });
}
