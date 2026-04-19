import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase'; // ⚡ FIXED IMPORT
import { sendWhatsAppOTP } from '@/lib/whatsapp';


export async function POST(req: Request) {
    try {
        const { phone } = await req.json();
        if (!phone) return NextResponse.json({ error: "Phone number required" }, { status: 400 });

        // Generate 4-digit code & expiration (10 mins)
        const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

        // Save to Database
        const { error: dbError } = await supabase
            .from('otp_requests')
            .upsert({ phone, code: otpCode, expires_at: expiresAt });

        if (dbError) throw dbError;

        // Trigger WhatsApp
        const sent = await sendWhatsAppOTP(phone, otpCode);
        if (!sent) return NextResponse.json({ error: "Failed to send message" }, { status: 500 });

        return NextResponse.json({ success: true, message: "OTP Sent" });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
