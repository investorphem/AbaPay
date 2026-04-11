import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase'; // ⚡ Imported your centralized master client

export async function POST(req: Request) {
  try {
    const { id, refundHash } = await req.json();

    if (!id || !refundHash) {
      return NextResponse.json({ success: false, message: "Missing transaction ID or refund hash" }, { status: 400 });
    }

    // Force the database update using the master admin client (bypasses RLS)
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
