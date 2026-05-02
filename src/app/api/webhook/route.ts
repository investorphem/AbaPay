import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/utils/supabase'; // Your secure backend DB client

export async function POST(req: Request) {
    try {
        const body = await req.json();
        
        // 1. Extract the event details sent by the Blockchain Listener (Alchemy/QuickNode)
        const txHash = body.transaction.hash;
        const { user, token, serviceType, accountNumber, amount } = body.event.args;

        // 2. Check if we already processed this transaction (prevents double-vending)
        const { data: existingTx } = await supabaseAdmin
            .from('transactions')
            .select('tx_hash')
            .eq('tx_hash', txHash)
            .single();

        if (existingTx) {
            return NextResponse.json({ message: "Transaction already processed." });
        }

        // 3. Save to Supabase (User's History is instantly updated!)
        await supabaseAdmin.from('transactions').insert({
            wallet_address: user,
            service_category: serviceType, // e.g., 'AIRTIME'
            account_number: accountNumber, // e.g., '08168811821'
            amount_crypto: amount,
            tx_hash: txHash,
            status: 'PENDING_VENDING',
            blockchain: 'BASE'
        });

        // 4. Trigger VTPass API quietly in the background
        // ... (Your VTPass fetch code goes here) ...

        // 5. Update Supabase to 'SUCCESS'
        // ...

        return NextResponse.json({ status: "Success" });

    } catch (error) {
        console.error("Webhook Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
