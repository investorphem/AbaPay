import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin as supabase } from '@/utils/supabase'; // ⚡ FIXED IMPORT
import { sendWhatsAppOTP } from '@/lib/whatsapp';


export async function POST(req: Request) {
    try {
        const { phone } = await req.json();
        if (!phone) return NextResponse.json({ error: "Phone number required" }, { status: 400 });

        // 🔐 INPUT VALIDATION: strict phone format (10-15 digits, optional +)
        const cleanPhone = String(phone).trim();
        if (!/^\+?\d{10,15}$/.test(cleanPhone)) {
            return NextResponse.json({ error: "Invalid phone number format" }, { status: 400 });
        }

        // 🔐 RESEND COOLDOWN: blocks OTP spam / SMS-bombing (max 1 request per 60s per phone)
        const { data: existingOtp } = await supabase
            .from('otp_requests')
            .select('expires_at')
            .eq('phone', cleanPhone)
            .single();

        if (existingOtp) {
            const issuedAt = new Date(existingOtp.expires_at).getTime() - 10 * 60000;
            if (Date.now() - issuedAt < 60000) {
                return NextResponse.json({ error: "Please wait a minute before requesting another code." }, { status: 429 });
            }
        }

        // 🔐 Generate cryptographically secure 4-digit code & expiration (10 mins)
        const otpCode = crypto.randomInt(1000, 10000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

        // Save to Database
        const { error: dbError } = await supabase
            .from('otp_requests')
            .upsert({ phone: cleanPhone, code: otpCode, expires_at: expiresAt });

        if (dbError) throw dbError;

        // Trigger WhatsApp
        const sent = await sendWhatsAppOTP(cleanPhone, otpCode);
        if (!sent) return NextResponse.json({ error: "Failed to send message" }, { status: 500 });

        return NextResponse.json({ success: true, message: "OTP Sent" });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
