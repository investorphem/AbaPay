import { supabaseAdmin } from '@/utils/supabase';
import { receiptImageResponse } from '@/lib/deai/receiptCard';

export const alt = 'AbaPay Receipt';
export const size = { width: 960, height: 760 };
export const contentType = 'image/png';
// Never statically generate this at build time — transaction data changes (PENDING -> SUCCESS,
// etc.) and there's no fixed set of request_ids to prerender. Also avoids running a live
// Supabase query + WASM image render during `next build`'s page-data collection pass.
export const dynamic = 'force-dynamic';

// Same card the MCP tool returns inline in chat — reused here so a shared receipt link also
// gets a proper preview image when pasted into Slack/iMessage/Twitter/etc. Never includes
// purchased_code/units — see the page.tsx in this route for why.
export default async function Image({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const { data: tx } = await supabaseAdmin.from('transactions').select('*').eq('request_id', requestId).maybeSingle();

  const row = tx as any;
  const ok = row?.status === 'SUCCESS';
  const serviceLabel = row ? `${(row.network || '').toUpperCase()} ${row.service_category || ''}`.trim() : 'Receipt not found';

  return receiptImageResponse({
    status: ok ? 'SUCCESS' : 'FAILED_VENDING',
    serviceLabel,
    accountNumber: row?.account_number || '',
    customerName: row?.customer_name || null,
    customerAddress: row?.customer_address || null,
    displayAmountNgn: row ? `NGN ${Number(row.amount_naira || 0).toLocaleString()}` : '—',
    cryptoCharged: row ? `${row.amount_usdt} ${row.token_used || 'USD₮'}` : '',
    purchasedCode: null,
    units: null,
    referenceId: row?.request_id || null,
    txHash: row?.tx_hash || '',
    chain: row?.blockchain || 'CELO',
  });
}
