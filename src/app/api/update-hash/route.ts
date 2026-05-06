import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';

export async function POST(req: Request) {
    try {
        const { bundleId, realTxHash } = await req.json();

        if (!bundleId || !realTxHash) {
            return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
        }

        // Find the ghost transaction and update it with the real blockchain hash
        const { error } = await supabaseAdmin
            .from('transactions')
            .update({ tx_hash: realTxHash })
            .eq('tx_hash', bundleId)
            .eq('status', 'PENDING');

        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
