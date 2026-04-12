import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';

export async function POST(req: Request) {
  try {
    const { request_id, tx_hash } = await req.json();

    if (!request_id) {
      return NextResponse.json({ success: false, message: "Missing request_id" }, { status: 400 });
    }

    // ⚡ 1. Fetch the original transaction to know if we are expecting a code
    const { data: txData } = await supabase
      .from('transactions')
      .select('service_category')
      .eq('request_id', request_id)
      .single();

    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    // 2. Ask VTpass for the final status
    const requeryRes = await fetch(`${baseUrl}/requery`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ request_id })
    });

    const requeryData = await requeryRes.json();
    const actualStatus = requeryData.content?.transactions?.status;

    if (actualStatus === 'delivered' || actualStatus === 'successful') {

      let dbPurchasedCode = requeryData.purchased_code || 
                            requeryData.token || 
                            requeryData.content?.transactions?.token || 
                            requeryData.content?.transactions?.purchased_code || 
                            requeryData.Pin || 
                            null;

      if (!dbPurchasedCode) {
          const rawString = JSON.stringify(requeryData);
          const tokenMatch = rawString.match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i);
          if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, '');
      }

      let vendedUnits = requeryData.units || requeryData.content?.transactions?.units || null;

      // ⚡ NEW: STRICT TOKEN REQUIREMENT FOR REQUERY ⚡
      const serviceCategory = txData?.service_category;
      const requiresCode = serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION';

      if (requiresCode && !dbPurchasedCode) {
          // It's still missing the code! Refuse to mark as success.
          return NextResponse.json({ success: true, status: 'PENDING', message: 'Provider is still generating the Token/PIN. Please check back again.' });
      }

      // Update Database to SUCCESS
      await supabase.from('transactions').update({ 
        status: 'SUCCESS',
        purchased_code: dbPurchasedCode,
        units: vendedUnits?.toString()
      }).eq('request_id', request_id);

      try { await sendTelegramAlert(`✅ *DELAYED TX SUCCESS*\nHash: \`${tx_hash}\`\nVTpass eventually delivered this pending transaction!`); } catch (e) {}

      return NextResponse.json({ success: true, status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits });

    } else if (actualStatus === 'failed') {

      await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('request_id', request_id);
      try { await sendTelegramAlert(`🚨 *DELAYED TX FAILED*\nHash: \`${tx_hash}\`\nVTpass rejected this pending transaction. User is ready for a refund.`); } catch (e) {}

      return NextResponse.json({ success: true, status: 'FAILED_VENDING' });

    } else {
      return NextResponse.json({ success: true, status: 'PENDING', message: 'Transaction is still processing at the provider.' });
    }

  } catch (error: any) {
    console.error("Requery Error:", error.message);
    return NextResponse.json({ success: false, message: "Server error while querying status" }, { status: 500 });
  }
}
