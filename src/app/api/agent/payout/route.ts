import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { verifySelfAgentRequest } from '@/lib/selfAgent';
import { fromBytea, PAYOUT_LIST_COLUMNS, type PayoutRow } from '@/lib/bankPayouts';

// GET /api/agent/payout?tx=0x… — a verified agent reads the bank transfer it paid for: its status,
// the transfer reference and, with &proof=1, the receipt itself.
//
// The details are the payee's bank account, so this answers only the agent that paid: the request
// must be signed with the same Self agent key the payment was made under (x-self-agent-* headers,
// src/lib/selfAgent.ts). Any other caller gets "not found", never distinguishable from a payment
// that doesn't exist. A key whose human proof has expired since may still read its own payment.

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ success: false, error: 'No bank transfer with that reference was found for this agent.' }, { status: 404 });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tx = String(url.searchParams.get('tx') || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return NextResponse.json({ success: false, error: 'tx is required: the 0x transaction hash the payment returned.' }, { status: 400 });
  }

  const self = await verifySelfAgentRequest(req, '');
  if (!self.present) {
    return NextResponse.json({ success: false, error: 'Sign this request with the Self agent key the payment was made under (x-self-agent-address, x-self-agent-signature, x-self-agent-timestamp).' }, { status: 401 });
  }
  if (self.status === 'invalid' || self.status === 'unavailable' || !self.agentAddress) {
    return NextResponse.json({ success: false, error: 'detail' in self ? self.detail : 'The Self agent signature could not be checked.' }, { status: self.status === 'unavailable' ? 503 : 401 });
  }

  const { data } = await supabase.from('bank_payouts').select(PAYOUT_LIST_COLUMNS).ilike('tx_hash', tx).maybeSingle();
  const po = data as PayoutRow | null;
  if (!po || po.self_agent_address.toLowerCase() !== self.agentAddress.toLowerCase()) return notFound();

  if (url.searchParams.get('proof') === '1') {
    if (po.status !== 'PAID' || !po.proof_mime) return notFound();
    const { data: img } = await supabase.from('bank_payouts').select('proof_image').eq('id', po.id).maybeSingle();
    const bytes = fromBytea((img as { proof_image?: unknown } | null)?.proof_image);
    if (!bytes) return notFound();
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': po.proof_mime, 'Cache-Control': 'private, no-store' } });
  }

  return NextResponse.json({
    success: true,
    tx_hash: po.tx_hash,
    status: po.status === 'AWAITING' ? 'AWAITING_PAYOUT' : po.status,
    message: po.status === 'AWAITING'
      ? 'Paid. The bank transfer is queued and will show a reference once it is sent.'
      : po.status === 'PAID' ? 'Sent.' : 'Not sent: the payment is being refunded to the paying wallet.',
    amount_ngn: Number(po.amount_ngn),
    bank: po.bank_name, bank_code: po.bank_code, account_number: po.account_number, account_name: po.account_name,
    self_agent_id: po.self_agent_id,
    ...(po.status === 'PAID' ? {
      reference: po.payout_reference,
      sent_at: po.paid_at,
      proof_url: po.proof_mime ? `${url.origin}/api/agent/payout?tx=${po.tx_hash}&proof=1` : null,
    } : {}),
  });
}
