import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram'; // Assuming these exist in your lib
import { sendAbaPaySms } from '@/lib/messaging';

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

        const txHash = activity.hash;

        // 2. Handle Alchemy Test Ping
        if (txHash === "0xTestTransactionHash") {
            console.log("✅ Alchemy Test Successful for abapays.com");
            return NextResponse.json({ message: "Test Successful" });
        }

        // 3. THE RETRY LOOP (Wait for Frontend to save Record)
        let transactionRecord = null;
        let retries = 5; 

        while (retries > 0) {
            const { data } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('tx_hash', txHash)
                .single();

            if (data) {
                transactionRecord = data;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1500)); 
            retries--;
        }

        if (!transactionRecord) {
            return NextResponse.json({ error: "Record not found" }, { status: 404 });
        }

        // Avoid double processing
        if (transactionRecord.status === 'SUCCESS') {
            return NextResponse.json({ message: "Already processed" });
        }

        // 4. TRIGGER VTPASS VENDING
        try {
            console.log(`🚀 Triggering VTPass for: ${transactionRecord.account_number}`);

            const vtpassResponse = await fetch('https://api-service.vtpass.com/api/pay', {
                method: 'POST',
                headers: {
                    'api-key': process.env.VTPASS_API_KEY!,
                    'secret-key': process.env.VTPASS_SECRET_KEY!,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    request_id: transactionRecord.request_id,
                    serviceID: transactionRecord.service_category,
                    billersCode: transactionRecord.account_number,
                    variation_code: transactionRecord.variation_code, 
                    amount: transactionRecord.amount_naira,
                    phone: transactionRecord.account_number 
                })
            });

            const result = await vtpassResponse.json();

            // Scenario A: Instant Success
            if (result.code === '000') {
                const token = result.purchased_code || result.token || null;
                
                await supabaseAdmin.from('transactions').update({ 
                    status: 'SUCCESS',
                    purchased_code: token,
                    amount_crypto: activity.value,
                    asset_symbol: activity.asset || 'USDC'
                }).eq('tx_hash', txHash);

                // Send Notifications
                await Promise.allSettled([
                    sendTelegramAlert(`✅ *INSTANT SUCCESS*\n👤 *User:* ${transactionRecord.account_number}\n💰 *Naira:* ₦${transactionRecord.amount_naira}`),
                    earnedPointsUpdate(transactionRecord.wallet_address, transactionRecord.amount_naira)
                ]);

                return NextResponse.json({ status: "Vending Success" });
            } 
            
            // Scenario B: Pending/Delayed (Let the OTHER webhook handle it)
            else if (result.code === '099') {
                await supabaseAdmin.from('transactions').update({ 
                    status: 'PENDING_VENDING',
                    amount_crypto: activity.value 
                }).eq('tx_hash', txHash);

                return NextResponse.json({ status: "Vending Pending" });
            }

            // Scenario C: VTPass Rejected it immediately
            else {
                throw new Error(result.response_description || "VTPass Error");
            }

        } catch (vendingError: any) {
            console.error("❌ Vending Failed:", vendingError.message);
            await supabaseAdmin.from('transactions').update({ 
                status: 'VENDING_FAILED' 
            }).eq('tx_hash', txHash);
            
            await sendTelegramAlert(`🚨 *VENDING FAILED*\nHash: ${txHash}\nError: ${vendingError.message}`);
            return NextResponse.json({ error: "Vending Failed" }, { status: 500 });
        }

    } catch (error) {
        console.error("Webhook System Error:", error);
        return NextResponse.json({ error: "Internal Error" }, { status: 500 });
    }
}

// Helper to award AbaPoints
async function earnedPointsUpdate(wallet: string, amount: number) {
    const points = Number((amount / 1000).toFixed(2));
    if (points > 0) {
        await supabaseAdmin.rpc('award_transaction_points', { 
            target_wallet: wallet.toLowerCase(), 
            points_to_add: points 
        });
    }
}
