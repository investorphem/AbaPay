import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { ONCHAIN_CHAINS, type OnchainChain } from '@/lib/onchain/config';

// CSV of every indexed payment on one chain, so anyone can check the numbers on /agents/stats
// against the chain themselves: each row carries its transaction hash and an explorer link.
// Everything in it is already public on-chain; no customer data is stored in the table at all.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const COLUMNS = 'block_time, tx_hash, log_index, block_number, contract, contract_label, payer, token_symbol, amount_usd, rail, service_type, tags';

const csvCell = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export async function GET(req: Request) {
  const chain = (new URL(req.url).searchParams.get('chain') || 'CELO').toUpperCase();
  if (chain !== 'CELO' && chain !== 'BASE') return new Response('chain must be CELO or BASE', { status: 400 });
  const explorer = ONCHAIN_CHAINS[chain as OnchainChain].explorer;

  const lines = [`${COLUMNS.replaceAll(' ', '')},explorer_url`];
  // PostgREST caps a response at 1,000 rows, so page through.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from('onchain_payments')
      .select(COLUMNS)
      .eq('chain', chain)
      .order('block_time', { ascending: false })
      .order('log_index', { ascending: true })
      .range(from, from + 999);
    if (error) return new Response('Could not read the index right now.', { status: 503 });
    for (const r of data as Record<string, unknown>[]) {
      lines.push([...COLUMNS.split(', ').map((c) => csvCell(r[c])), `${explorer}/tx/${r.tx_hash}`].join(','));
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
