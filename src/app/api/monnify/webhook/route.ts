import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { verifyWebhookSignature } from '@/lib/monnify';
import { finalizeMonnifyTransfer } from '@/lib/monnifyVend';

// ⚡ MONNIFY DISBURSEMENT WEBHOOK — the async completion signal for a bank transfer submitted
// with async: true (see initiateTransfer in src/lib/monnify.ts). Every field here comes from
// an unauthenticated POST, so nothing is trusted until the HMAC-SHA512 `monnify-signature`
// header checks out against our own secret key (see verifyWebhookSignature).

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('monnify-signature');

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('[Monnify Webhook] Invalid signature — rejecting.');
      return NextResponse.json({ received: true, message: 'Invalid signature.' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body?.eventType;
    const eventData = body?.eventData || {};
    const reference = eventData.reference;

    if (!reference) {
      return NextResponse.json({ received: true, message: 'No reference in payload.' });
    }

    const { data: record } = await supabase.from('transactions').select('tx_hash, service_category').eq('request_id', reference).maybeSingle();
    if (!record || record.service_category !== 'BANK') {
      // Not one of ours (or already a different service category) — acknowledge and ignore.
      return NextResponse.json({ received: true, message: 'No matching bank-transfer record.' });
    }

    if (eventType === 'SUCCESSFUL_DISBURSEMENT') {
      await finalizeMonnifyTransfer({ txHash: record.tx_hash, reference, outcome: 'SUCCESS', raw: body });
    } else if (eventType === 'FAILED_DISBURSEMENT' || eventType === 'REVERSED_DISBURSEMENT') {
      await finalizeMonnifyTransfer({ txHash: record.tx_hash, reference, outcome: 'FAILED', raw: body, failureReason: eventData.responseMessage || eventType });
    }
    // Other event types (e.g. SETTLEMENT) aren't relevant to a single transfer's lifecycle — acknowledged, ignored.

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error('[Monnify Webhook] handler failed:', error.message);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
