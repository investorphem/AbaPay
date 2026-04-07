import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// 🛡️ Initialize Supabase with the SERVICE ROLE KEY to bypass Row Level Security (RLS)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { id, refundHash } = await req.json();

    if (!id || !refundHash) {
      return NextResponse.json({ success: false, message: "Missing transaction ID or refund hash" }, { status: 400 });
    }

    // Force the database update using the master admin client
    const { error } = await supabaseAdmin
      .from('transactions')
      .update({ status: 'REFUNDED', refund_hash: refundHash })
      .eq('id', id);

    if (error) {
      console.error("Refund DB Update Error:", error.message);
      return NextResponse.json({ success: false, message: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Server Error:", error.message);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
