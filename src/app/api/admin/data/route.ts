import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [txRes, usersRes, walletsRes, settingsRes] = await Promise.all([
            supabase.from('transactions').select('*').order('created_at', { ascending: false }),
            supabase.from('abapay_users').select('*').order('total_points', { ascending: false }),
            supabase.from('wallet_links').select('*').is('user_id', null).order('unclaimed_points', { ascending: false }),
            supabase.from('platform_settings').select('*').eq('id', 1).single()
        ]);

        return NextResponse.json({
            success: true,
            transactions: txRes.data || [],
            users: usersRes.data || [],
            wallets: walletsRes.data || [],
            settings: settingsRes.data || {}
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, message: e.message }, { status: 500 });
    }
}
