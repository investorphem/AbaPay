import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase'; // ⚡ FIXED IMPORT
import { enforceRateLimit } from '@/lib/rateLimit';


export async function POST(req: Request) {
    // 🛡️ Throttle confirm attempts per IP. Note the code itself is already burn-on-failure
    // (a single wrong guess deletes the OTP), so brute force is not viable; this limit
    // mainly protects the DB from being hammered.
    const limited = await enforceRateLimit(req, 'otp-confirm', 15, 60);
    if (limited) return limited;

    try {
        const { phone, code, walletAddress } = await req.json();
        if (!phone || !code || !walletAddress) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        // 🔐 INPUT VALIDATION: wallet must be a valid EVM address
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(walletAddress))) {
            return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
        }

        // 1. Verify OTP
        const { data: otpRecord } = await supabase
            .from('otp_requests')
            .select('*')
            .eq('phone', phone)
            .single();

        if (!otpRecord) {
            return NextResponse.json({ error: "Invalid OTP code" }, { status: 400 });
        }

        if (new Date(otpRecord.expires_at) < new Date()) {
            return NextResponse.json({ error: "OTP has expired" }, { status: 400 });
        }

        // 🔐 CONSTANT-TIME COMPARE + SINGLE ATTEMPT: a wrong guess burns the code,
        // so a 4-digit OTP cannot be brute forced (each guess requires a fresh OTP).
        const expected = Buffer.from(String(otpRecord.code));
        const provided = Buffer.from(String(code));
        const matches = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);

        if (!matches) {
            await supabase.from('otp_requests').delete().eq('phone', phone);
            return NextResponse.json({ error: "Invalid OTP code. Please request a new code." }, { status: 400 });
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
        // Don't leak internals to the client; log server-side instead.
        console.error('[verify/confirm] error:', error?.message);
        return NextResponse.json({ error: "Could not verify code. Please try again." }, { status: 500 });
    }
}
