import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { verifySignatureAcrossChains } from '@/utils/walletAuth';
import { buildAgentPolicyMessage, CONFIRM_SIGNATURE_MAX_AGE_MS, type AgentPolicyForm } from '@/lib/adminActionMessages';
import { clearAgentPolicyCache, POLICY_COLUMNS } from '@/lib/agentPolicy';
import { decodeProof, fromBytea, markBankPayoutPaid, PAYOUT_LIST_COLUMNS, refundBankPayout } from '@/lib/bankPayouts';

// ⚡ ADMIN: outside agents (x402, MCP, A2A) — the verified-agent switches and caps
// (src/lib/agentPolicy.ts, migration 048) and the queue of verified agents' bank transfers
// (src/lib/bankPayouts.ts). Separate from /api/admin/agent, which is AbaPay's own chat agent.
//
// GET                         settings + payouts (newest first; AWAITING ones always included)
// GET ?proof=<payout id>      that payout's receipt
// POST { policy, confirmSignature, confirmTimestamp }   save the switches and caps (fresh signature)
// POST { payout: { id, action: 'paid', reference, proof?, note? } }   record a sent transfer
// POST { payout: { id, action: 'refund', reason } }                   not sent: refund the agent

export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  const proofId = new URL(req.url).searchParams.get('proof');
  if (proofId) {
    const { data } = await supabaseAdmin.from('bank_payouts').select('proof_image, proof_mime').eq('id', proofId).maybeSingle();
    const bytes = fromBytea((data as { proof_image?: unknown } | null)?.proof_image);
    const mime = (data as { proof_mime?: string } | null)?.proof_mime;
    if (!bytes || !mime) return NextResponse.json({ success: false, message: 'No receipt on file.' }, { status: 404 });
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': mime, 'Cache-Control': 'private, no-store' } });
  }

  const [{ data: settings, error }, awaiting, recent] = await Promise.all([
    supabaseAdmin.from('platform_settings').select(POLICY_COLUMNS).eq('id', 1).single(),
    supabaseAdmin.from('bank_payouts').select(PAYOUT_LIST_COLUMNS).eq('status', 'AWAITING').order('created_at', { ascending: true }),
    supabaseAdmin.from('bank_payouts').select(PAYOUT_LIST_COLUMNS).neq('status', 'AWAITING').order('created_at', { ascending: false }).limit(50),
  ]);
  if (error) return NextResponse.json({ success: false, message: 'Could not load the outside-agent settings (is migration 048 applied?).' }, { status: 500 });
  return NextResponse.json({ success: true, settings, payouts: [...(awaiting.data || []), ...(recent.data || [])] });
}

const capOrNull = (v: unknown): number | null | 'bad' => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 'bad';
};

export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, message: 'Invalid JSON.' }, { status: 400 }); }
  const admin = String(auth.address || 'admin');

  if (body.policy && typeof body.policy === 'object') {
    const p = body.policy as Record<string, unknown>;
    const caps = {
      agent_ext_max_ngn_per_tx: capOrNull(p.agent_ext_max_ngn_per_tx),
      agent_ext_daily_cap_ngn: capOrNull(p.agent_ext_daily_cap_ngn),
      verified_agent_max_ngn_per_tx: capOrNull(p.verified_agent_max_ngn_per_tx),
      verified_agent_daily_cap_ngn: capOrNull(p.verified_agent_daily_cap_ngn),
    };
    if (Object.values(caps).includes('bad')) return NextResponse.json({ success: false, message: 'Each limit must be a positive naira amount, or empty for none.' }, { status: 400 });
    const policy: AgentPolicyForm = {
      ...(caps as { [K in keyof typeof caps]: number | null }),
      verified_agent_discounts_enabled: p.verified_agent_discounts_enabled === true,
      verified_agent_fee_waiver_enabled: p.verified_agent_fee_waiver_enabled === true,
      verified_agent_higher_limits_enabled: p.verified_agent_higher_limits_enabled === true,
      verified_agent_bank_enabled: p.verified_agent_bank_enabled === true,
    };

    // These move money (perks, caps, bank transfers), so every save takes a fresh wallet signature
    // over exactly what is saved, on top of the admin session.
    const ts = Number(body.confirmTimestamp);
    if (!body.confirmSignature || !Number.isFinite(ts)) return NextResponse.json({ success: false, message: 'Missing wallet confirmation: please sign to save.' }, { status: 400 });
    if (Date.now() - ts > CONFIRM_SIGNATURE_MAX_AGE_MS || ts > Date.now() + 60_000) return NextResponse.json({ success: false, message: 'Confirmation expired: please try again.' }, { status: 401 });
    const valid = await verifySignatureAcrossChains(admin, buildAgentPolicyMessage({ ...policy, timestamp: ts }), String(body.confirmSignature));
    if (!valid) return NextResponse.json({ success: false, message: 'Signature does not match: nothing was saved.' }, { status: 401 });

    const { error } = await supabaseAdmin.from('platform_settings').update(policy).eq('id', 1);
    if (error) return NextResponse.json({ success: false, message: `Could not save: ${error.message}` }, { status: 500 });
    clearAgentPolicyCache();
    return NextResponse.json({ success: true });
  }

  if (body.payout && typeof body.payout === 'object') {
    const p = body.payout as Record<string, unknown>;
    const id = String(p.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ success: false, message: 'Payout id is required.' }, { status: 400 });

    if (p.action === 'paid') {
      let proof: ReturnType<typeof decodeProof> = null;
      if (p.proof) {
        proof = decodeProof(String(p.proof));
        if (!proof) return NextResponse.json({ success: false, message: 'The receipt must be a PNG, JPEG, WebP or PDF of at most 2 MB.' }, { status: 400 });
      }
      const r = await markBankPayoutPaid({ payoutId: id, reference: String(p.reference || ''), proof, note: p.note ? String(p.note) : null, admin });
      return r.ok ? NextResponse.json({ success: true }) : NextResponse.json({ success: false, message: r.error }, { status: 400 });
    }
    if (p.action === 'refund') {
      const r = await refundBankPayout({ payoutId: id, reason: String(p.reason || ''), admin });
      return r.ok ? NextResponse.json({ success: true }) : NextResponse.json({ success: false, message: r.error }, { status: 400 });
    }
    return NextResponse.json({ success: false, message: "action must be 'paid' or 'refund'." }, { status: 400 });
  }

  return NextResponse.json({ success: false, message: 'Nothing to do.' }, { status: 400 });
}
