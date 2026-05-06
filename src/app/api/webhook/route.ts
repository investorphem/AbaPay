import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass'; 
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_for_build");

const error_messages: Record<string, string> = {
    "011": "Invalid details provided. Please check your phone/meter number and try again.",
    "012": "This product is currently unavailable.",
    "013": "Amount is below the minimum allowed.",
    "014": "Transaction exceeds your daily limit with this provider.",
    "016": "The provider network is currently unstable. Please try again.",
    "017": "Amount is above the maximum allowed for this product.",
    "018": "Service is temporarily unavailable. Try again shortly.", 
    "019": "Duplicate transaction detected. Please wait 30 seconds before retrying.",
    "021": "Service is temporarily undergoing maintenance. Please try again later.",
    "022": "Service is temporarily undergoing maintenance. Please try again later.",
    "023": "Service is temporarily undergoing maintenance. Please try again later.",
    "024": "Service is temporarily undergoing maintenance. Please try again later.",
    "027": "Service is temporarily undergoing maintenance. Please try again later.", 
    "028": "This specific product is temporarily unavailable. Please try another service.", 
    "030": "Provider network is currently down. Please try again.",
    "034": "Service is currently suspended by the provider. Please try again later.",
    "035": "Service is inactive at the moment. Please try again later.",
    "041": "A network error occurred. Please contact support if your funds were deducted.",
    "089": "The network is processing your previous request. Please wait.",
    "400": "Transaction failed due to a system error. Please try again.",
    "FAILED_VERIFICATION": "Verification failed. The provided meter or account number is invalid."
};

export async function POST(req: Request) {
    try {
        const rawBody = await req.text();
        const signature = req.headers.get('x-alchemy-signature');
        
        // ⚡ LOAD BOTH SECRETS (Base and Celo) ⚡
        const baseSecret = process.env.ALCHEMY_WEBHOOK_SECRET;
        const celoSecret = process.env.ALCHEMY_CELO_WEBHOOK_SECRET;

        if (!signature || (!baseSecret && !celoSecret)) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        let isValid = false;

        // 1. Try checking against the Base Secret
        if (baseSecret) {
            const hmac = crypto.createHmac('sha256', baseSecret);
            const digest = hmac.update(rawBody).digest('hex');
            if (signature === digest) isValid = true;
        }

        // 2. If it wasn't Base, try checking against the Celo Secret
        if (!isValid && celoSecret) {
            const hmacCelo = crypto.createHmac('sha256', celoSecret);
            const digestCelo = hmacCelo.update(rawBody).digest('hex');
            if (signature === digestCelo) isValid = true;
        }

        // If neither key matched, reject the request
        if (!isValid) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }

        const body = JSON.parse(rawBody);
        const activity = body.event?.activity?.[0];

        if (!activity) return NextResponse.json({ message: "No activity" });

        const txHash = activity.hash;

        // Handle Alchemy Test Ping
        if (txHash === "0xTestTransactionHash") {
            console.log("✅ Alchemy Test Successful for abapays.com");
            return NextResponse.json({ message: "Test Successful" });
        }

                // 3. THE RETRY LOOP (With Atomic Locking)
        let record = null;
        let retries = 5;

        while (retries > 0) {
            const { data: exactMatch } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('tx_hash', txHash)
                .single();

            // ⚡ ATOMIC LOCK: Claim the transaction so no duplicate webhooks can touch it
            if (exactMatch && exactMatch.status === 'PENDING') {
                const { data: lockedRecord, error: lockError } = await supabaseAdmin
                    .from('transactions')
                    .update({ status: 'PROCESSING' })
                    .eq('tx_hash', txHash)
                    .eq('status', 'PENDING') // Optimistic locking
                    .select()
                    .single();

                if (lockedRecord && !lockError) {
                    record = lockedRecord;
                    break;
                } else {
                    return NextResponse.json({ message: "Already processing by another webhook execution" });
                }
            }

            if (exactMatch && exactMatch.status !== 'PENDING') {
                return NextResponse.json({ message: "Already processed" });
            }

            await new Promise(resolve => setTimeout(resolve, 2000)); 
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
        let payRes, payData;
        try {
            payRes = await fetch(`${baseUrl}/pay`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(vtpassPayload) });
            payData = await payRes.json();
        } catch (e: any) {
            await supabaseAdmin.from('transactions').update({ status: 'VENDING_FAILED', error_code: '502_TIMEOUT', api_response: e.message || 'Fetch failed entirely' }).eq('tx_hash', txHash);
            try { await sendTelegramAlert(`❌ *NETWORK CRASH (LIVE)*\n⛓️ *Chain:* ${record.blockchain}\n🛒 *Product:* ${record.network} ${record.service_category}\n👤 *User:* ${record.account_number}\n⚠️ Connection to VTpass timed out.`); } catch (err) {}
            return NextResponse.json({ status: "Vending Failed (Network)" }, { status: 200 }); 
        }

        // 6. HANDLE SUCCESS / PENDING (000 or 099)
        if (payData.code === '000' || payData.code === '099') {
            const actualStatus = payData.content?.transactions?.status || 'pending';

            if (actualStatus === 'delivered' || actualStatus === 'successful') {
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

                await supabaseAdmin.from('transactions').update({ status: 'SUCCESS', purchased_code: dbPurchasedCode, units: vendedUnits }).eq('tx_hash', txHash);

                const notifications = [];
                notifications.push(sendTelegramAlert(`✅ *SALE SUCCESSFUL*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n💰 *Naira:* ₦${record.amount_naira}\n🪙 *Asset:* ${record.amount_usdt} ${record.token_used || 'USD₮'}\n👤 *User:* ${record.account_number}\n🧾 *Ref:* ${alertTokenRef}`));

                if (record.service_category === 'ELECTRICITY' || record.service_category === 'EDUCATION') {
                    const typeLabel = record.service_category === 'ELECTRICITY' ? 'Token' : 'PIN';
                    notifications.push(sendAbaPaySms(record.phone || record.account_number, `AbaPay: Your ${record.network || record.service_category} ${typeLabel} is ${alertTokenRef}. Amount: N${record.amount_naira}. Thank you.`));
                }

                if (record.customer_email) {
                    notifications.push(resend.emails.send({
                        from: 'AbaPay Receipts <receipts@abapays.com>',
                        to: record.customer_email,
                        replyTo: 'support@abapays.com', 
                        subject: `AbaPay Receipt - ${record.network} ${record.service_category}`,
                        html: `<div style="font-family: sans-serif; background-color: #f4f4f5; padding: 40px 0;"><div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden;"><div style="background: #18181b; padding: 40px 30px; text-align: center;"><h1 style="color:white">AbaPay</h1></div><div style="padding: 40px 30px;"><h2 style="color: #18181b; font-size: 32px;">₦${record.amount_naira.toLocaleString()}</h2><p>Account: ${record.account_number}</p><p>Tx Hash: ${txHash}</p>${dbPurchasedCode ? `<p style="color:#10b981; font-weight:bold;">Token / PIN: ${dbPurchasedCode}</p>` : ``}</div></div></div>`
                    }));
                }

                const points = Number((record.amount_naira / 1000).toFixed(2));
                if (points > 0 && record.wallet_address) {
                    notifications.push(supabaseAdmin.rpc('award_transaction_points', { target_wallet: record.wallet_address.toLowerCase(), points_to_add: points }));
                }

                await Promise.allSettled(notifications);
                return NextResponse.json({ status: "Vending Success" });

            } else {
                return NextResponse.json({ status: "Vending Delayed" });
            }

        } else {
            const friendlyMessage = error_messages[payData.code as string] || "Service is temporarily undergoing maintenance.";
            const rawTechnicalError = payData.response_description || payData.content?.errors || "Unknown VTpass Rejection";

            await supabaseAdmin.from('transactions').update({ status: 'VENDING_FAILED', error_code: payData.code, api_response: rawTechnicalError }).eq('tx_hash', txHash);
            await sendTelegramAlert(`❌ *VENDING REJECTED*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n👤 *User:* ${record.account_number}\n🚨 *Admin Error:* Code ${payData.code} - ${rawTechnicalError}\n🗣 *User Message:* ${friendlyMessage}`);

            return NextResponse.json({ status: "Vending Rejected" }, { status: 200 }); 
        }

    } catch (error: any) {
        console.error("Webhook System Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
