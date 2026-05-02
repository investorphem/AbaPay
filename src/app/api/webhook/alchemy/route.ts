import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase'; // Ensure you use the Service Role key here!

export async function POST(req: Request) {
    try {
        const body = await req.json();

        // 1. Alchemy sends the event details in the body
        // Ensure this matches the JSON structure Alchemy sends for Custom Webhooks
        const event = body.event; 
        const txHash = event.transaction.hash;
        
        // Extract the decoded arguments from your PaymentReceived event
        const { user, token, serviceType, accountNumber, amount } = event.data.decoded;

        // 2. Prevent Double-Vending
        // Check if we've already successfully processed this transaction
        const { data: existingTx } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('tx_hash', txHash)
            .single();

        if (existingTx && existingTx.status === 'SUCCESS') {
            return NextResponse.json({ message: "Already processed" });
        }

        // 3. We either update the PENDING record the frontend created, 
        // OR we insert a new one if the user's frontend crashed before it could.
        let txId = existingTx?.id;

        if (!existingTx) {
            const { data: newTx } = await supabaseAdmin.from('transactions').insert({
                wallet_address: user,
                tx_hash: txHash,
                service_category: serviceType,
                account_number: accountNumber,
                amount_crypto: amount,
                status: 'PROCESSING_VENDING'
            }).select().single();
            txId = newTx.id;
        } else {
            await supabaseAdmin.from('transactions').update({ status: 'PROCESSING_VENDING' }).eq('id', txId);
        }

        // 4. Trigger the VTPass API
        // WARNING: Replace this with your actual VTPass logic
        const vtpassSuccess = true; // await callVTPassAPI(serviceType, accountNumber, amount);

        // 5. Final Update -> THIS TRIGGERS THE FRONTEND REAL-TIME LISTENER
        if (vtpassSuccess) {
            await supabaseAdmin.from('transactions').update({ status: 'SUCCESS' }).eq('id', txId);
        } else {
            await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING' }).eq('id', txId);
        }

        return NextResponse.json({ ok: true });

    } catch (error) {
        console.error("Webhook Error:", error);
        return NextResponse.json({ error: "Server Error" }, { status: 500 });
    }
}
