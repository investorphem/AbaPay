import { supabaseAdmin } from '@/utils/supabase';
import { explorerBaseFor } from '@/lib/chain';
import { logoForServiceId } from '@/lib/providerFallback';
import { issuesTokenOrPin } from '@/lib/purchasedCode';
import Link from 'next/link';
import type { Metadata } from 'next';

// ⚡ PUBLIC, SHAREABLE RECEIPT PAGE — the "premium transaction page" surfaced from MCP's
// pay_bill/transaction_history tools (see src/lib/deai/receiptCard.tsx for the inline image
// version of the same data). No auth: the whole point is a link a user can forward.
//
// 🔴 SECURITY — keyed by request_id, NOT tx_hash, and NEVER shows purchased_code/units:
// a tx_hash is visible to anyone watching the vault address on-chain, so keying a page that
// shows the customer's verified NAME and ADDRESS (electricity/JAMB) by tx_hash would let a
// blockchain observer correlate a public transaction to that PII. request_id is the same
// unguessable (36^12 keyspace — see getStrictRequestId in src/lib/vend.ts) reference this
// codebase already treats as the secure lookup key for sensitive per-transaction data. The
// electricity token / exam PIN itself is a bearer secret — it's in the MCP tool response and
// the receipt email (both private, owner-only channels), never on this public page.

// Never statically generate — a transaction's status can change after the fact (PENDING ->
// SUCCESS, or SUCCESS -> REFUNDED), and there's no fixed set of request_ids to prerender.
export const dynamic = 'force-dynamic';

async function getReceipt(requestId: string) {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('request_id', requestId)
    .maybeSingle();
  return data as any;
}

export async function generateMetadata({ params }: { params: Promise<{ requestId: string }> }): Promise<Metadata> {
  const { requestId } = await params;
  const tx = await getReceipt(requestId);
  const title = tx ? `AbaPay Receipt — ${(tx.network || '').toUpperCase()} ${tx.service_category || ''}`.trim() : 'AbaPay Receipt';
  return { title, description: tx ? `₦${Number(tx.amount_naira || 0).toLocaleString()} — ${tx.status}` : 'Receipt not found' };
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-4 py-3 border-b border-slate-800/60 last:border-0">
      <span className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</span>
      <span className={`text-sm font-bold text-slate-100 text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const tx = await getReceipt(requestId);

  if (!tx) {
    return (
      <main className="min-h-screen bg-black text-slate-100 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#15151a] border border-slate-800/60 rounded-[2rem] p-10 text-center">
          <h1 className="text-xl font-black mb-2">Receipt not found</h1>
          <p className="text-sm text-slate-400">This link doesn't match a real AbaPay transaction.</p>
          <Link href="/" className="inline-block mt-6 text-sm font-bold text-emerald-400 hover:text-emerald-300">
            Go to AbaPay →
          </Link>
        </div>
      </main>
    );
  }

  const ok = tx.status === 'SUCCESS';
  const isElectricity = String(tx.service_category || '').toUpperCase() === 'ELECTRICITY';
  const serviceLabel = `${(tx.network || '').toUpperCase()} ${tx.service_category || ''}`.trim();
  const isRealTx = String(tx.tx_hash || '').startsWith('0x');
  const explorerUrl = isRealTx ? `${explorerBaseFor(tx.blockchain)}/tx/${tx.tx_hash}` : null;
  const date = new Date(tx.created_at).toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <main className="min-h-screen bg-black text-slate-100 flex flex-col items-center p-6 sm:p-10">
      <div className="max-w-lg w-full">
        <div className="bg-[#15151a] border border-slate-800/60 rounded-[2rem] p-8 sm:p-10 shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="AbaPay" className="h-7 w-auto" />
              <span className="text-xl font-black tracking-tight">AbaPay</span>
            </div>
            <span className="text-xs font-bold uppercase tracking-widest text-slate-500 border border-slate-800 rounded-full px-3 py-1">
              {tx.blockchain || 'CELO'}
            </span>
          </div>

          <div className="flex items-center gap-3 mb-8">
            <span
              className={`flex items-center justify-center w-9 h-9 rounded-full font-black text-black ${
                ok ? 'bg-emerald-400' : tx.status === 'REFUNDED' ? 'bg-blue-400' : 'bg-red-400'
              }`}
            >
              {ok ? '✓' : '!'}
            </span>
            <span
              className={`text-lg font-black ${
                ok ? 'text-emerald-400' : tx.status === 'REFUNDED' ? 'text-blue-400' : 'text-red-400'
              }`}
            >
              {ok ? 'Payment Successful' : tx.status === 'REFUNDED' ? 'Refunded' : tx.status}
            </span>
          </div>

          {/* Provider logo beside the amount — the same idea as the in-app receipt and the
              history row, so a receipt looks like itself wherever it is opened. White plate
              because this page is dark and several provider marks are dark-on-transparent. */}
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">Amount Paid</p>
              <p className="text-4xl font-black">₦{Number(tx.amount_naira || 0).toLocaleString()}</p>
              <p className="text-sm text-slate-400 mt-1">{tx.amount_usdt} {tx.token_used || 'USD₮'}</p>
            </div>
            <div className="shrink-0 w-14 h-14 rounded-2xl bg-white flex items-center justify-center overflow-hidden shadow-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoForServiceId(tx.service_id)} alt="" aria-hidden="true" className="w-10 h-10 object-contain select-none" />
            </div>
          </div>

          <div>
            <Row label="Service" value={serviceLabel} />
            <Row label={isElectricity ? 'Meter Number' : 'Account'} value={tx.account_number} />
            {tx.customer_name ? <Row label="Name" value={tx.customer_name} /> : null}
            {tx.customer_address ? <Row label="Address" value={tx.customer_address} /> : null}
            <Row label="Date" value={date} />
            {tx.request_id ? <Row label="Reference" value={tx.request_id} mono /> : null}
          </div>

          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 flex items-center justify-between text-sm font-bold text-emerald-400 hover:text-emerald-300 border-t border-slate-800/60 pt-6"
            >
              <span className="font-mono text-xs text-slate-500">{tx.tx_hash.slice(0, 10)}...{tx.tx_hash.slice(-8)}</span>
              <span>View on-chain →</span>
            </a>
          )}

          {/* 🔴 This note used to fire for ALL electricity, telling a POSTPAID customer their
              token "was sent privately" — a token that is never issued, since a postpaid meter
              is a billed account. issuesTokenOrPin splits the two cases so each one gets the
              statement that is actually true for it. */}
          {ok && issuesTokenOrPin(tx.service_category, tx.variation_code) && (
            <p className="mt-6 text-[11px] text-slate-500 text-center">
              The {isElectricity ? 'token' : 'PIN'} for this purchase was sent privately and isn&apos;t shown on this shareable page.
            </p>
          )}
          {ok && isElectricity && !issuesTokenOrPin(tx.service_category, tx.variation_code) && (
            <p className="mt-6 text-[11px] text-slate-500 text-center">
              This is a postpaid account — the payment was credited directly to the bill, so no
              meter token is issued.
            </p>
          )}
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          Secured by AbaPay on {tx.blockchain || 'Celo'} · <Link href="/" className="underline hover:text-slate-400">abapays.com</Link>
        </p>
      </div>
    </main>
  );
}
