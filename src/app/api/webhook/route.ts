import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';

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

        // 3. THE RETRY LOOP (Crucial for 'Choice A' Logic)
        // This waits for the frontend to finish inserting the record if Alchemy is faster.
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

            console.log(`🔄 Waiting for DB record for ${txHash}... Retries left: ${retries}`);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5 seconds
            retries--;
        }

        // 4. Validate Transaction Status
        if (!transactionRecord) {
            console.error("❌ Transaction not found in DB after retries.");
            return NextResponse.json({ error: "Transaction record missing" }, { status: 404 });
        }

        if (transactionRecord.status === 'SUCCESS') {
            return NextResponse.json({ message: "Already processed" });
        }

        // 5. TRIGGER VTPASS VENDING
        // Because we used 'Choice A', transactionRecord now contains:
        // .account_number and .service_category
        try {
            console.log(`🚀 Triggering VTPass for: ${transactionRecord.account_number}`);
            
            // --- YOUR VTPASS LOGIC HERE ---
            // const vendingResponse = await callVTPassAPI(transactionRecord);
            
            // 6. UPDATE DB TO SUCCESS
            const { error: updateError } = await supabaseAdmin
                .from('transactions')
                .update({ 
                    status: 'SUCCESS',
                    amount_crypto: activity.value, // Confirming actual value from chain
                    asset_symbol: activity.asset || 'USDC'
                })
                .eq('tx_hash', txHash);

            if (updateError) throw updateError;

            // Optional: Update User Points/Rewards here

            return NextResponse.json({ status: "Vending Successful", hash: txHash });

        } catch (vendingError) {
            console.error("❌ VTPass Vending Failed:", vendingError);
            
            // Mark as VENDING_FAILED so user/admin can see it in history
            await supabaseAdmin
                .from('transactions')
                .update({ status: 'VENDING_FAILED' })
                .eq('tx_hash', txHash);

            return NextResponse.json({ error: "Vending failed" }, { status: 500 });
        }

    } catch (error) {
        console.error("Webhook System Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
