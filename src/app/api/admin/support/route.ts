import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { sendTelegramToUser } from '@/lib/telegram';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

// ⚡ ADMIN: SUPPORT DESK
//
// Tickets arrive from the web app AND every social channel. The operator replies here, and
// the answer is delivered back to the user ON THE CHANNEL THEY USED — a Telegram user gets
// their reply in Telegram, not an email they'll never open.

export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') || 'OPEN';

  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ success: false, message: 'Could not load tickets.' }, { status: 500 });
  }

  const { data: open } = await supabaseAdmin.from('support_tickets').select('id, channel').eq('status', 'OPEN');

  return NextResponse.json({
    success: true,
    tickets: data || [],
    summary: {
      openCount: (open || []).length,
      byChannel: (open || []).reduce((acc: any, t: any) => {
        acc[t.channel] = (acc[t.channel] || 0) + 1;
        return acc;
      }, {}),
    },
  });
}

export async function POST(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  try {
    const { id, reply, close } = await req.json();
    if (!id) return NextResponse.json({ success: false, message: 'Ticket id required' }, { status: 400 });

    const { data: ticket } = await supabaseAdmin.from('support_tickets').select('*').eq('id', id).single();
    if (!ticket) return NextResponse.json({ success: false, message: 'Ticket not found' }, { status: 404 });

    if (close && !reply) {
      await supabaseAdmin.from('support_tickets').update({ status: 'CLOSED' }).eq('id', id);
      return NextResponse.json({ success: true, message: 'Ticket closed.' });
    }

    if (!reply || !String(reply).trim()) {
      return NextResponse.json({ success: false, message: 'Reply is required' }, { status: 400 });
    }

    const t = ticket as any;
    let delivered = false;

    // 📲 Deliver back on the channel they actually used.
    if (t.channel === 'TELEGRAM' && t.channel_user_id) {
      const res = await sendTelegramToUser(t.channel_user_id, `🎫 *AbaPay Support*\n\n${reply}\n\n_Reply here if you need anything else._`);
      delivered = !!res;
    }

    // Email fallback / additional.
    if (t.customer_email) {
      try {
        await resend.emails.send({
          from: 'AbaPay Support <support@abapays.com>',
          to: t.customer_email,
          replyTo: 'support@abapays.com',
          subject: 'Re: your AbaPay support request',
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;">
            <p style="color:#334155;white-space:pre-line;">${String(reply)}</p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
            <p style="color:#94a3b8;font-size:12px;">You wrote: "${String(t.message).slice(0, 200)}"</p>
          </div>`,
        });
        delivered = true;
      } catch { /* best-effort */ }
    }

    await supabaseAdmin.from('support_tickets').update({
      status: close ? 'CLOSED' : 'ANSWERED',
      admin_reply: reply,
      replied_by: auth.address || 'admin',
      replied_at: new Date().toISOString(),
    }).eq('id', id);

    return NextResponse.json({
      success: true,
      message: delivered ? 'Reply sent to the user.' : 'Reply saved, but we had no channel to deliver it on.',
      delivered,
    });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
