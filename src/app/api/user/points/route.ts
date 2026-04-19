import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase'; 

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const walletAddress = searchParams.get('wallet');

        if (!walletAddress) {
            return NextResponse.json({ error: "Wallet address required" }, { status: 400 });
        }

        // Fetch the wallet link and join with the master profile if it exists
        const { data, error } = await supabase
            .from('wallet_links')
            .select(`
                unclaimed_points,
                user_id,
                abapay_users (
                    total_points,
                    verified_phone
                )
            `)
            .eq('wallet_address', walletAddress.toLowerCase())
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows found"
            throw error;
        }

        // If they have no history at all, return 0
        if (!data) {
            return NextResponse.json({ points: 0, isLinked: false });
        }

        // If they are linked to a master profile, return the master points
        if (data.abapay_users) {
            return NextResponse.json({ 
                points: data.abapay_users.total_points, 
                isLinked: true,
                phoneMasked: data.abapay_users.verified_phone.replace(/.(?=.{4})/g, '*') // e.g., *******5678
            });
        }

        // If they just have unverified points on this wallet
        return NextResponse.json({ 
            points: data.unclaimed_points, 
            isLinked: false 
        });

    } catch (error: any) {
        console.error("Points Fetch Error:", error.message);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
