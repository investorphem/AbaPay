import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';

// ⚡ ADMIN: DeAI agent controls.
//
// These are the operator's emergency brakes now that the agent can actually spend money.
// They take effect within ~30s (the rules cache TTL) with no redeploy and no contract call.
//
// NOTE: these sit ON TOP of the on-chain allowance, not instead of it. Even if every switch
// here were bypassed, AbaPayV3 still refuses to spend beyond what each user personally
// signed for. Defence in depth.

export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .select('agent_enabled, agent_autonomous_enabled, agent_max_ngn_per_tx, agent_daily_cap_ngn, ai_chat_enabled')
    .eq('id', 1)
    .single();

  if (error) {
    return NextResponse.json({ success: false, message: 'Could not load agent settings.' }, { status: 500 });
  }

  // Live operational stats so the operator can see what the agent is actually doing.
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data: links } = await supabaseAdmin.from('agent_links').select('id, channel, link_verified').eq('is_active', true);
  const { data: schedules } = await supabaseAdmin.from('scheduled_bills').select('id, auto_execute').eq('is_active', true);

  return NextResponse.json({
    success: true,
    settings: data,
    stats: {
      linkedChannels: (links || []).filter((l: any) => l.link_verified).length,
      pendingLinks: (links || []).filter((l: any) => !l.link_verified).length,
      byChannel: (links || []).reduce((acc: any, l: any) => {
        if (l.link_verified) acc[l.channel] = (acc[l.channel] || 0) + 1;
        return acc;
      }, {}),
      activeSchedules: (schedules || []).length,
      autonomousSchedules: (schedules || []).filter((s: any) => s.auto_execute).length,
    },
  });
}

export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  try {
    const body = await req.json();
    const update: Record<string, any> = {};

    if (typeof body.agent_enabled === 'boolean') update.agent_enabled = body.agent_enabled;
    if (typeof body.agent_autonomous_enabled === 'boolean') update.agent_autonomous_enabled = body.agent_autonomous_enabled;
    if (typeof body.ai_chat_enabled === 'boolean') update.ai_chat_enabled = body.ai_chat_enabled;

    if (body.agent_max_ngn_per_tx !== undefined) {
      const v = Number(body.agent_max_ngn_per_tx);
      if (!Number.isFinite(v) || v < 0) return NextResponse.json({ success: false, message: 'Invalid per-transaction cap' }, { status: 400 });
      update.agent_max_ngn_per_tx = v;
    }
    if (body.agent_daily_cap_ngn !== undefined) {
      const v = Number(body.agent_daily_cap_ngn);
      if (!Number.isFinite(v) || v < 0) return NextResponse.json({ success: false, message: 'Invalid daily cap' }, { status: 400 });
      update.agent_daily_cap_ngn = v;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ success: false, message: 'Nothing to update' }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from('platform_settings').update(update).eq('id', 1);
    if (error) {
      console.error('[Admin] agent settings update failed:', error.message);
      return NextResponse.json({ success: false, message: 'Could not save settings.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, updated: update });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
