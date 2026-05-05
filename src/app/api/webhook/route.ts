import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass'; 
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

export async function POST(req: Request) {
    try {
        // 1. Signature Verification (Security)
        const rawBody = await req.text();
        const signature = req.headers.get('x-alchemy-signature');
        const secret = process.env.ALCHEMY_WEBHOOK_SECRET;

        if (!signature || !secret) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(rawBody).digest('hex');

        if (signature !== digest) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }

        const body = JSON.parse(rawBody);
        const activity = body.event?.activity?.[0];

        if (!activity) {
            return NextResponse.json({ message: "No activity" });
        }

        // Use exact hash from the blockchain event
        const txHash = activity.hash;

        // 2. Handle Alchemy Test Ping
        if (txHash === "0xTestTransactionHash") {
            console.log("✅ Alchemy Test Successful for abapays.com");
            return NextResponse.json({ message: "Test Successful" });
        }

        // 3. THE RETRY LOOP (Wait for Frontend to save the PENDING record)
        let record = null;
        let retries = 4; // Max wait ~6 seconds (Leaves enough Vercel time for VTPass)

        while (retries > 0) {
            const { data } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('tx_hash', txHash)
                .single();

            if (data && data.status === 'PENDING') {
                record = data;
                break;
            }
            if (data && data.status !== 'PENDING') {
                return NextResponse.json({ message: "Already processed" });
            }
            await new Promise(resolve => setTimeout(resolve, 1500)); 
            retries--;
        }

        if (!record) {
            return NextResponse.json({ error: "Record not found or not PENDING" }, { status: 404 });
        }

        console.log(`🚀 Triggering VTPass for: ${record.account_number} on ${record.blockchain}`);

        // 4. CONSTRUCT VTPASS PAYLOAD
        const isForeign = record.service_id === 'foreign-airtime';
        const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
        const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

        let vtpassPayload: any = {
            request_id: record.request_id,
            serviceID: record.service_id, 
            amount: record.amount_naira,
            phone: record.phone || record.account_number
        };

        if (isForeign) {
            vtpassPayload.billersCode = record.account_number;
            vtpassPayload.variation_code = record.variation_code;
            vtpassPayload.operator_id = record.operator_id;
            vtpassPayload.country_code = record.country_code;
            vtpassPayload.product_type_id = record.product_type_id;
            vtpassPayload.email = record.customer_email || "support@abapay.com";
        } else {
            if (['DATA', 'ELECTRICITY', 'BANK'].includes(record.service_category)) {
                vtpassPayload.billersCode = record.account_number;
                vtpassPayload.variation_code = record.variation_code;
            } else if (record.service_category === 'EDUCATION') {
                vtpassPayload.variation_code = record.variation_code;
                if (record.service_id === 'jamb') vtpassPayload.billersCode = record.account_number; 
            } else if (record.service_category === 'INTERNET') {
                vtpassPayload.billersCode = record.account_number;
                vtpassPayload.variation_code = record.variation_code;
                if (record.service_id === 'spectranet') vtpassPayload.quantity = 1;
            } else if (record.service_category === 'CABLE') {
                vtpassPayload.billersCode = record.account_number;
                if (['dstv', 'gotv'].includes(record.service_id)) {
                    vtpassPayload.subscription_type = record.subscription_type;
                    if (record.subscription_type === 'change') {
                        vtpassPayload.variation_code = record.variation_code;
                        vtpassPayload.quantity = 1;
                    }
                } else {
                    vtpassPayload.variation_code = record.variation_code;
                }
            }
        }

        // 5. EXECUTE VENDING
        const payRes = await fetch(`${baseUrl}/pay`, {
            method: 'POST',
            headers: getHeaders(), 
            body: JSON.stringify(vtpassPayload)
        });
        
        const payData = await payRes.json();

        // 6. HANDLE SUCCESS / PENDING (000 or 099)
        if (payData.code === '000' || payData.code === '099') {
            const actualStatus = payData.content?.transactions?.status || 'pending';

            if (actualStatus === 'delivered' || actualStatus === 'successful') {
                
                // Extract Token/PIN
                let dbPurchasedCode = null;
                let vendedUnits = null;
                let alertTokenRef = "Success";

                if (record.service_category === 'ELECTRICITY' && !isForeign) {
                    dbPurchasedCode = payData.purchased_code || payData.token || payData.content?.transactions?.token || payData.content?.transactions?.purchased_code || null;
                    if (!dbPurchasedCode) {
                        const tokenMatch = JSON.stringify(payData).match(/(?:\b|Token:?\s*)(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/i);
                        if (tokenMatch) dbPurchasedCode = tokenMatch[1].replace(/[-\s]/g, '');
                    }
                    alertTokenRef = dbPurchasedCode || "Processing Token";
                    vendedUnits = payData.units?.toString() || payData.content?.transactions?.units?.toString() || null;
                } else if (record.service_category === 'EDUCATION') {
                    dbPurchasedCode = payData.purchased_code || payData.Pin || null;
                    alertTokenRef = dbPurchasedCode || "Processing PIN";
                } else {
                    alertTokenRef = payData.content?.transactions?.transactionId || payData.requestId || "Success";
                }

                // Update Database
                await supabaseAdmin.from('transactions').update({ 
                    status: 'SUCCESS',
                    purchased_code: dbPurchasedCode, 
                    units: vendedUnits 
                }).eq('tx_hash', txHash);

                // 7. FIRE OFF NOTIFICATIONS IN BACKGROUND
                const notifications = [];
                notifications.push(
                    sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n💰 *Naira:* ₦${record.amount_naira}\n🪙 *Asset:* ${record.amount_usdt} ${record.token_used || 'USD₮'}\n👤 *User:* ${record.account_number}\n🧾 *Ref:* ${alertTokenRef}`)
                );

                if (record.service_category === 'ELECTRICITY' || record.service_category === 'EDUCATION') {
                    const typeLabel = record.service_category === 'ELECTRICITY' ? 'Token' : 'PIN';
                    notifications.push(
                        sendAbaPaySms(record.phone || record.account_number, `AbaPay: Your ${record.network || record.service_category} ${typeLabel} is ${alertTokenRef}. Amount: N${record.amount_naira}. Thank you.`)
                    );
                }

                if (record.customer_email) {
                    notifications.push(resend.emails.send({
                        from: 'AbaPay Receipts <receipts@abapays.com>',
                        to: record.customer_email,
                        replyTo: 'support@abapays.com', 
                        subject: `AbaPay Receipt - ${record.network} ${record.service_category}`,
                        html: `
                          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; padding: 40px 0; margin: 0;">
                            <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
                              <div style="background: linear-gradient(135deg, #18181b 0%, #000000 100%); padding: 40px 30px; text-align: center; border-bottom: 3px solid #10b981;">
                                <img src="https://abapays.com/logo.png" alt="AbaPay" style="max-height: 45px; width: auto; margin: 0 auto; display: block;" />
                              </div>
                              <div style="padding: 40px 30px;">
                                <p style="margin: 0 0 10px; color: #52525b; font-size: 14px; text-transform: uppercase; font-weight: 600;">Transaction Successful</p>
                                <h2 style="margin: 0 0 30px; color: #18181b; font-size: 32px;">₦${record.amount_naira.toLocaleString()}</h2>
                                <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                                  <tr><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Network</td><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; text-align: right; font-weight: 500;">${record.blockchain || 'CELO'}</td></tr>
                                  <tr><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Service</td><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; text-align: right; font-weight: 500;">${record.network} ${record.service_category}</td></tr>
                                  <tr><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Account</td><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; text-align: right; font-weight: 500;">${record.account_number}</td></tr>
                                  <tr><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Tx Hash</td><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #18181b; text-align: right; font-weight: 500; word-break: break-all;">${txHash}</td></tr>
                                  ${dbPurchasedCode ? `<tr><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Token / PIN</td><td style="padding: 15px 0; border-bottom: 1px solid #e4e4e7; color: #10b981; font-size: 18px; text-align: right; font-weight: bold; letter-spacing: 2px;">${dbPurchasedCode}</td></tr>` : ``}
                                </table>
                              </div>
                            </div>
                          </div>
                        `
                    }));
                }

                const points = Number((record.amount_naira / 1000).toFixed(2));
                if (points > 0 && record.wallet_address) {
                    notifications.push(supabaseAdmin.rpc('award_transaction_points', { target_wallet: record.wallet_address.toLowerCase(), points_to_add: points }));
                }

                await Promise.allSettled(notifications);
                return NextResponse.json({ status: "Vending Success" });

            } else {
                // Keep as pending
                return NextResponse.json({ status: "Vending Delayed" });
            }

        } else {
            // VTPASS FAILED
            await supabaseAdmin.from('transactions').update({ 
                status: 'VENDING_FAILED',
                error_code: payData.code,
                api_response: payData.response_description || payData.content?.errors || "Unknown VTpass Rejection"
            }).eq('tx_hash', txHash);

            await sendTelegramAlert(`❌ *VENDING REJECTED*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n🚨 *Error:* Code ${payData.code} - ${payData.response_description}`);
            
            return NextResponse.json({ error: "Vending Failed" }, { status: 500 });
        }

    } catch (error: any) {
        console.error("Webhook System Error:", error);
        return NextResponse.json({ error: "Internal Error" }, { status: 500 });
    }
}
