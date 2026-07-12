import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

export async function POST(req: Request) {
  // 🔐 SECURITY (H-1): This endpoint returns `purchased_code` — the electricity meter
  // token or WAEC/JAMB PIN that the customer actually paid for. Those are BEARER SECRETS:
  // whoever holds the code can redeem the value.
  //
  // Previously this route had NO authentication and NO ownership check, so anyone who
  // presented a valid `request_id` received another customer's token. Request IDs were
  // additionally generated with a predictable timestamp prefix + Math.random() (not a
  // CSPRNG), and there was no rate limit — making enumeration realistic.
  //
  // The only legitimate caller is the admin dashboard (src/app/admin/page.tsx), which
  // already holds admin credentials, so we now require the same wallet-signature admin
  // auth used by every other /api/admin/* route.
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // Throttle regardless — limits damage if admin credentials are ever compromised,
  // and stops the VTpass requery endpoint (a billable call) being hammered.
  const limited = await enforceRateLimit(req, 'requery', 30, 60);
  if (limited) return limited;

  try {
    const { request_id, tx_hash } = await req.json();

    if (!request_id) {
      return NextResponse.json({ success: false, message: "Missing request_id" }, { status: 400 });
    }

    // ⚡ 1. FETCH FULL RECORD: We need points, emails, and phone numbers ⚡
    const { data: record } = await supabase
      .from('transactions')
      .select('*')
      .eq('request_id', request_id)
      .single();

    if (!record) {
        return NextResponse.json({ success: false, message: "Transaction record not found" }, { status: 404 });
    }

    // 🔐 DEFENSE IN DEPTH: the caller must also present the correct on-chain tx hash for
    // this record. Knowing a request_id alone is no longer sufficient to pull a token —
    // the two must belong to the same transaction. (The admin dashboard already sends
    // both, so this costs nothing legitimate.)
    if (!tx_hash || String(tx_hash).toLowerCase() !== String(record.tx_hash || '').toLowerCase()) {
      console.warn(`[SECURITY] Requery rejected: tx_hash mismatch for request_id ${request_id}`);
      return NextResponse.json({ success: false, message: "Transaction record not found" }, { status: 404 });
    }

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

      // STRICT TOKEN REQUIREMENT FOR REQUERY
      const serviceCategory = record.service_category;
      const requiresCode = serviceCategory === 'ELECTRICITY' || serviceCategory === 'EDUCATION';

      if (requiresCode && !dbPurchasedCode) {
          return NextResponse.json({ success: true, status: 'PENDING', message: 'Provider is still generating the Token/PIN. Please check back again.' });
      }

      // 🔐 ATOMIC CLAIM: only the first successful requery transitions the record.
      // Prevents replaying /api/requery to farm points or spam SMS/email receipts.
      const { data: claimed } = await supabase.from('transactions').update({ 
        status: 'SUCCESS',
        purchased_code: dbPurchasedCode,
        units: vendedUnits?.toString()
      }).eq('request_id', request_id).neq('status', 'SUCCESS').select();

      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ success: true, status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits, message: 'Transaction already completed.' });
      }

      // ⚡ 3. FIRE DELAYED NOTIFICATIONS & POINTS ⚡
      const alertTokenRef = dbPurchasedCode || requeryData.content?.transactions?.transactionId || "Success";
      const notifications = [];

      notifications.push(
          sendTelegramAlert(`✅ *DELAYED TX SUCCESS (REQUERY)*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n💰 *Naira:* ₦${record.amount_naira}\n🪙 *Asset:* ${record.amount_usdt} ${record.token_used || 'USD₮'}\n👤 *User:* ${record.account_number}\n🧾 *Ref:* ${alertTokenRef}`)
      );

      if (record.service_category === 'ELECTRICITY' || record.service_category === 'EDUCATION') {
          const typeLabel = record.service_category === 'ELECTRICITY' ? 'Token' : 'PIN';
          notifications.push(
              sendAbaPaySms(record.phone || record.account_number, `AbaPay: Your delayed ${record.network || record.service_category} ${typeLabel} is ${alertTokenRef}. Amount: N${record.amount_naira}. Thank you.`)
          );
      }

      if (record.customer_email) {
          notifications.push(resend.emails.send({
              from: 'AbaPay Receipts <receipts@abapays.com>',
              to: record.customer_email,
              replyTo: 'support@abapays.com', 
              subject: `AbaPay Receipt - ${record.network} ${record.service_category} (Delayed)`,
              html: `
                <div style="font-family: -apple-system, sans-serif; background-color: #f4f4f5; padding: 40px 0;">
                  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden;">
                    <div style="background: linear-gradient(135deg, #18181b 0%, #000000 100%); padding: 40px 30px; text-align: center; border-bottom: 3px solid #10b981;">
                      <h1 style="color: white; margin: 0;">AbaPay.</h1>
                    </div>
                    <div style="padding: 40px 30px;">
                      <p style="margin: 0 0 10px; color: #52525b; font-size: 14px; text-transform: uppercase; font-weight: 600;">Delayed Transaction Successful</p>
                      <h2 style="margin: 0 0 30px; color: #18181b; font-size: 32px;">₦${record.amount_naira.toLocaleString()}</h2>
                      <p style="color: #71717a;">Your pending transaction has been successfully processed.</p>
                      ${dbPurchasedCode ? `
                      <div style="margin-top: 20px; padding: 15px; border: 2px dashed #10b981; text-align: center; border-radius: 8px;">
                          <p style="color: #71717a; margin: 0 0 5px;">Your Token / PIN:</p>
                          <h3 style="color: #10b981; font-size: 24px; margin: 0; letter-spacing: 2px;">${dbPurchasedCode}</h3>
                      </div>
                      ` : ''}
                    </div>
                  </div>
                </div>
              `
          }));
      }

      const points = Number((record.amount_naira / 1000).toFixed(2));
      if (points > 0 && record.wallet_address) {
          notifications.push(supabase.rpc('award_transaction_points', { target_wallet: record.wallet_address.toLowerCase(), points_to_add: points }));
      }

      await Promise.allSettled(notifications);

      return NextResponse.json({ success: true, status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits, earnedPoints: points });

    } else if (actualStatus === 'failed') {

      await supabase.from('transactions').update({ status: 'FAILED_VENDING' }).eq('request_id', request_id);
      
      try { await sendTelegramAlert(`🚨 *DELAYED TX FAILED (REQUERY)*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n👤 *User:* ${record.account_number}\nVTpass finally rejected this pending transaction. User is ready for a refund.`); } catch (e) {}

      return NextResponse.json({ success: true, status: 'FAILED_VENDING' });

    } else {
      return NextResponse.json({ success: true, status: 'PENDING', message: 'Transaction is still processing at the provider.' });
    }

  } catch (error: any) {
    console.error("Requery Error:", error.message);
    return NextResponse.json({ success: false, message: "Server error while querying status" }, { status: 500 });
  }
}
