import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { errorMessage } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    // 🔐 SECURITY: this endpoint exposes all user PII and transactions
    const auth = await verifyAdminRequest(req);
    if (!auth.authorized) {
        return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
    }

    try {
        const [txRes, usersRes, unlinkedWalletsRes, allWalletsRes, settingsRes, identitiesRes, clientInfoRes] = await Promise.all([
            supabase.from('transactions').select('*').order('created_at', { ascending: false }),
            supabase.from('abapay_users').select('*').order('total_points', { ascending: false }),
            supabase.from('wallet_links').select('*').is('user_id', null).order('unclaimed_points', { ascending: false }),
            supabase.from('wallet_links').select('wallet_address, abapay_users(verified_phone)'), // ⚡ NEW: Fetches the verified phone for the Ledger
            supabase.from('platform_settings').select('*').eq('id', 1).single(),
            // Which agent paid (src/lib/payerIdentity.ts): admin-only, never on a public surface.
            supabase.from('payer_identities').select('*'),
            supabase.from('payment_client_info').select('*'),
        ]);

        return NextResponse.json({
            success: true,
            transactions: txRes.data || [],
            users: usersRes.data || [],
            wallets: unlinkedWalletsRes.data || [],
            allWallets: allWalletsRes.data || [], // ⚡ PASS TO FRONTEND
            settings: settingsRes.data || {},
            payerIdentities: identitiesRes.data || [],
            paymentClientInfo: clientInfoRes.data || [],
        });
    } catch (e) {
        return NextResponse.json({ success: false, message: errorMessage(e) }, { status: 500 });
    }
}
