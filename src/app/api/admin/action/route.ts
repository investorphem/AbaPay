import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { action, payload } = body;

        if (action === 'ADJUST_POINTS') {
            const { isUser, id, newPoints } = payload;
            let dbError;
            
            if (isUser) {
                const { error } = await supabase.from('abapay_users').update({ total_points: newPoints }).eq('id', id);
                dbError = error;
            } else {
                const { error } = await supabase.from('wallet_links').update({ unclaimed_points: newPoints }).eq('wallet_address', id);
                dbError = error;
            }

            // ⚡ THE FIX: Catch the Supabase error!
            if (dbError) {
                return NextResponse.json({ success: false, message: dbError.message });
            }
        } 
        else if (action === 'UPDATE_KILL_SWITCHES') {
            const { error } = await supabase.from('platform_settings').update({ kill_switches: payload.switches }).eq('id', 1);
            
            // ⚡ THE FIX: Return the error if the kill switches failed to save!
            if (error) {
                return NextResponse.json({ success: false, message: error.message });
            }
        } else {
            return NextResponse.json({ success: false, message: "Unknown action provided." }, { status: 400 });
        }

        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ success: false, message: e.message || "Internal server error" }, { status: 500 });
    }
}
