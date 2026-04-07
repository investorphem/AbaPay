import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';

export async function POST(req: Request) {
  try {
    const { id, refundHash } = await req.json();

    // Uses the master backend key to force the database update
    const { error } = await supabase
      .from('transactions')
      .update({ status: 'REFUNDED', refund_hash: refundHash })
      .eq('id', id);

    if (error) {
      console.error("Refund DB Update Error:", error.message);
      return NextResponse.json({ success: false, message: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
