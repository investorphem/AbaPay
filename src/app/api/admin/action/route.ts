import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { action, payload } = body;

        if (action === 'ADJUST_POINTS') {
            const { isUser, id, newPoints } = payload;
            if (isUser) {
                await supabase.from('abapay_users').update({ total_points: newPoints }).eq('id', id);
            } else {
                await supabase.from('wallet_links').update({ unclaimed_points: newPoints }).eq('wallet_address', id);
            }
        } 
        else if (action === 'UPDATE_KILL_SWITCHES') {
            await supabase.from('platform_settings').update({ kill_switches: payload.switches }).eq('id', 1);
        }
        
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ success: false, message: e.message }, { status: 500 });
    }
}
