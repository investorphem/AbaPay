import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';

export async function POST(req: Request) {
    try {
        // 1. MUST read as text to verify the signature accurately
        const rawBody = await req.text();
        const signature = req.headers.get('x-alchemy-signature');
        const secret = process.env.ALCHEMY_WEBHOOK_SECRET;

        // Security Check
        if (!signature || !secret) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(rawBody).digest('hex');

        if (signature !== digest) {
            console.error("❌ Invalid Webhook Signature");
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }

        // 2. Parse the verified data
        const body = JSON.parse(rawBody);
        const activity = body.event?.activity?.[0];

        if (!activity) {
            return NextResponse.json({ message: "No activity found" });
        }

        const txHash = activity.hash;
        const userWallet = activity.fromAddress;

        // 3. Handle Alchemy Test Pings (Don't save to DB)
        if (txHash === "0xTestTransactionHash") {
            console.log("✅ Alchemy Test Notification Received for abapays.com");
            return NextResponse.json({ message: "Test Successful" });
        }

        // 4. Idempotency Check (Prevent double points/double vending)
        const { data: existingTx } = await supabaseAdmin
            .from('transactions')
            .select('tx_hash')
            .eq('tx_hash', txHash)
            .single();

        if (existingTx) {
            return NextResponse.json({ message: "Transaction already processed." });
        }

        /* NOTE: Alchemy Address Activity doesn't send Smart Contract 'args' (like account_number) directly.
           You will need to fetch the 'Pending' transaction from your DB that matches this txHash
           OR use a Trace API. For now, we update the status of the hash we just found.
        */

        // 5. Update/Insert into Supabase
        // We use 'upsert' or 'update' assuming the frontend already created a pending record
        const { error: dbError } = await supabaseAdmin.from('transactions').upsert({
            wallet_address: userWallet,
            tx_hash: txHash,
            amount_crypto: activity.value,
            status: 'PENDING_VENDING',
            blockchain: 'BASE',
            // If you have the asset type (USDC/USDT)
            asset_symbol: activity.asset || 'USDC' 
        });

        if (dbError) throw dbError;

        // 6. TODO: Trigger VTPass API 
        // This is where you call your vending logic using the accountNumber saved in your DB
        // const response = await triggerVTPassVending(txHash);

        return NextResponse.json({ status: "Success", hash: txHash });

    } catch (error) {
        console.error("Webhook Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
