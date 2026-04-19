import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
    try {
        const { phone, code, walletAddress } = await req.json();
        if (!phone || !code || !walletAddress) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        // 1. Verify OTP
        const { data: otpRecord } = await supabase
            .from('otp_requests')
            .select('*')
            .eq('phone', phone)
            .single();

        if (!otpRecord || otpRecord.code !== code) {
            return NextResponse.json({ error: "Invalid OTP code" }, { status: 400 });
        }

        if (new Date(otpRecord.expires_at) < new Date()) {
            return NextResponse.json({ error: "OTP has expired" }, { status: 400 });
        }

        // 2. Call the Supabase function to Link and Merge Points
        const { error: linkError } = await supabase.rpc('link_wallet_to_phone', { 
            target_wallet: walletAddress.toLowerCase(), 
            target_phone: phone 
        });

        if (linkError) {
            return NextResponse.json({ error: linkError.message }, { status: 400 });
        }

        // 3. Cleanup used OTP
        await supabase.from('otp_requests').delete().eq('phone', phone);

        return NextResponse.json({ success: true, message: "Wallet successfully linked!" });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
