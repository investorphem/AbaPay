import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { errorMessage } from '@/lib/errors';

export async function POST(req: Request) {
  // 🔐 SECURITY: the exchange rate prices all crypto payments (/api/pay trusts it)
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
  }

  try {
    const { newRate } = await req.json();
    
    // supabaseAdmin bypasses RLS to force the update
    const { error } = await supabaseAdmin
      .from('platform_settings')
      .update({ exchange_rate: Number(newRate) })
      .eq('id', 1);

    if (error) throw error;
    
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, message: errorMessage(error) }, { status: 500 });
  }
}
