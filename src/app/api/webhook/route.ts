import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendAbaPaySms } from '@/lib/messaging';
import { getHeaders } from '@/lib/vtpass'; 
import { Resend } from 'resend';
import { decodeEventLog, parseUnits } from 'viem';
import { ABAPAY_CONTRACT_ABI_EVENTS, resolveTokenOnChain } from '@/constants';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';
import { resolveChain, getPublicClient, explorerBaseFor } from '@/lib/chain';
import { buildReceiptEmail } from '@/lib/receiptEmail';

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

        const baseSecret = process.env.ALCHEMY_WEBHOOK_SECRET;
        const celoSecret = process.env.ALCHEMY_CELO_WEBHOOK_SECRET;

        if (!signature || (!baseSecret && !celoSecret)) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        let isValid = false;
        if (baseSecret) {
            const hmac = crypto.createHmac('sha256', baseSecret);
            const digest = hmac.update(rawBody).digest('hex');
            if (signature === digest) isValid = true;
        }

        if (!isValid && celoSecret) {
            const hmacCelo = crypto.createHmac('sha256', celoSecret);
            const digestCelo = hmacCelo.update(rawBody).digest('hex');
            if (signature === digestCelo) isValid = true;
        }

        if (!isValid) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }

        const body = JSON.parse(rawBody);
        const activity = body.event?.activity?.[0];

        if (!activity) return NextResponse.json({ message: "No activity" });

        const txHash = activity.hash;

        if (txHash === "0xTestTransactionHash") {
            console.log("✅ Alchemy Test Successful for abapays.com");
            return NextResponse.json({ message: "Test Successful" });
        }

        // ⚡ OPPORTUNISTIC STALE-PREFLIGHT SWEEP (no paid cron required) ⚡
        // Fire-and-forget: internally throttled to at most once every 5 min per warm
        // instance, and never blocks or delays this webhook's response. This keeps
        // abandoned pre-flight intents from lingering as PENDING on the free plan.
        cleanupStalePreflights().catch(() => {});

        // Extract the user's wallet address from Alchemy payload to find abandoned preflights
        const fromAddress = activity.fromAddress || null;

        // ⚡ FAST PRE-CHECK — SKIP THE EXPENSIVE PATH FOR IRRELEVANT EVENTS ⚡
        //
        // Alchemy fires on EVERY matching on-chain event for the watched address, not just our
        // app's payments. In production ~98% of all traffic hits this route, and most of those
        // events can never match a record — yet each one was paying the full cost below:
        // a 15s sleep + 5 retries x 2s + ~10 DB queries (~25s of serverless compute).
        //
        // WHY THIS IS SAFE: the pre-flight intent row is written BEFORE the user signs (see the
        // `intent_only` call in /api/pay). So by the time a transaction exists on-chain and
        // Alchemy tells us about it, a matching row MUST already exist — either keyed by the
        // real tx_hash, or still sitting as a `preflight_` row for that wallet. If neither is
        // present, this event has nothing to do with us and no amount of waiting will change
        // that. Genuine in-flight payments still get the full sleep + retry treatment below.
        {
            const { data: preExisting } = await supabaseAdmin
                .from('transactions')
                .select('status')
                .eq('tx_hash', txHash)
                .maybeSingle();

            // Already finished (SUCCESS / FAILED_VENDING / REFUNDED / PROCESSING) — nothing to do.
            if (preExisting && preExisting.status !== 'PENDING') {
                return NextResponse.json({ message: "Already processed" });
            }

            if (!preExisting) {
                // No row for this hash. Is there a pending pre-flight intent for this wallet
                // that we'd rescue? If not, this event isn't ours.
                let hasRescuable = false;
                if (fromAddress) {
                    const { data: pendingPreflight } = await supabaseAdmin
                        .from('transactions')
                        .select('id')
                        .ilike('wallet_address', fromAddress)
                        .eq('status', 'PENDING')
                        .like('tx_hash', 'preflight_%')
                        .limit(1)
                        .maybeSingle();
                    hasRescuable = !!pendingPreflight;
                }

                if (!hasRescuable) {
                    console.log(`Webhook: fast-exit, no pending record for tx ${txHash} (from: ${fromAddress || 'n/a'}).`);
                    return NextResponse.json({ message: "No matching record — acknowledged." }, { status: 200 });
                }
            }
        }

        // ⚡ 1. THE 15-SECOND SLEEP ⚡
        // Only reached when a genuine payment of ours is in flight. We wait to give the
        // frontend a chance to process the transaction synchronously first.
        await new Promise(resolve => setTimeout(resolve, 15000));

        // ⚡ 2. THE RETRY LOOP & CRASH RESCUE MISSION ⚡
        let record = null;
        let retries = 5;

        while (retries > 0) { 
            let { data: exactMatch } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('tx_hash', txHash)
                .single();

            // ⚡ RESCUE MISSION: If hash not found, search for an abandoned Pre-Flight intent!
            if (!exactMatch && fromAddress) {
                const { data: abandonedIntent } = await supabaseAdmin
                    .from('transactions')
                    .select('*')
                    .ilike('wallet_address', fromAddress) // ⚡ case-insensitive: Alchemy normalizes addresses to lowercase, but stored records may be checksummed mixed-case
                    .eq('status', 'PENDING')
                    .like('tx_hash', 'preflight_%')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (abandonedIntent) {
                    // We found the crashed intent! Rename it to the real blockchain hash.
                    await supabaseAdmin.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', abandonedIntent.tx_hash);
                    exactMatch = { ...abandonedIntent, tx_hash: txHash };
                }
            }

            // ATOMIC LOCK
            if (exactMatch && exactMatch.status === 'PENDING') {
                const { data: lockedRecord, error: lockError } = await supabaseAdmin
                    .from('transactions')
                    .update({ status: 'PROCESSING' })
                    .eq('tx_hash', txHash)
                    .eq('status', 'PENDING') 
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
            // ⚡ CRITICAL: Always acknowledge receipt with 2xx here — Alchemy treats any
            // non-2xx response as a DELIVERY failure and will auto-disable the webhook after
            // enough of them within a rolling window. "No matching record" is a normal,
            // expected outcome (test pings, unrelated activity picked up by the address
            // filter, or a real payment whose intent just hasn't synced to the DB yet) — it
            // is NOT a transport/delivery failure, and must never be reported as one.
            console.log(`Webhook: no matching PENDING record for tx ${txHash} (fromAddress: ${fromAddress || 'n/a'}). Acknowledging anyway.`);
            return NextResponse.json({ message: "No matching record found — acknowledged." }, { status: 200 });
        }

        // ⚡ 2.5 THE WEBHOOK SECURITY FIX: VERIFY ON-CHAIN RECEIPT ⚡
        // Chain/RPC resolution now comes from the shared helper (src/lib/chain.ts) so this
        // path and /api/admin/refund can't drift apart, and both get RPC failover.
        const { isMainnet } = resolveChain(record.blockchain);
        const explorerUrl = `${explorerBaseFor(record.blockchain)}/tx/${txHash}`;

        try {
            const publicClient = getPublicClient(record.blockchain);
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });

            // CRITICAL CHECK: Did the transaction fail on the blockchain?
            if (receipt.status !== 'success') {
                await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'REVERTED', api_response: 'Transaction failed on-chain' }).eq('tx_hash', txHash);
                try { await sendTelegramAlert(`🛑 *WEBHOOK BLOCKED: REVERTED TX*\nUser ${record.wallet_address || record.account_number} tried to use a failed/reverted transaction!\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
                return NextResponse.json({ status: "Transaction Reverted On-Chain. Blocked." }, { status: 200 });
            }

            // ⚡ PAYMASTER / ERC-4337 SAFE CHECK + FULL EVENT CROSS-VALIDATION ⚡
            // We don't just confirm the tx succeeded — we decode OUR contract's PaymentReceived
            // event and require that its user / token / amount / accountNumber MATCH the pending
            // record. Without this, a user could have a small pending intent, then manually send
            // a DIFFERENT amount (or different token) to the contract, and the webhook would
            // wrongly attach that transfer to the pending intent and vend it. This works whether
            // the call was a direct EOA tx or nested inside a sponsored UserOperation.
            const abapayContractAddress = (record.blockchain === 'BASE'
                ? (process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS)
                : (process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS)
            )?.toLowerCase();

            let matchedEvent: any = null;
            for (const log of receipt.logs) {
                if (log.address?.toLowerCase() !== abapayContractAddress) continue;
                try {
                    const decoded: any = decodeEventLog({ abi: ABAPAY_CONTRACT_ABI_EVENTS, data: log.data, topics: log.topics });
                    if (decoded.eventName === 'PaymentReceived') { matchedEvent = decoded.args; break; }
                } catch { /* not a PaymentReceived log */ }
            }

            if (!matchedEvent) {
                await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'NO_CONTRACT_EVENT', api_response: 'Transaction succeeded but AbaPay contract did not emit PaymentReceived' }).eq('tx_hash', txHash);
                try { await sendTelegramAlert(`🛑 *WEBHOOK BLOCKED: NO CONTRACT EVENT*\nTx succeeded but the AbaPay contract never emitted PaymentReceived — refusing to vend.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
                return NextResponse.json({ status: "No AbaPay PaymentReceived event found. Blocked." }, { status: 200 });
            }

            // 🔐 CROSS-CHECK 1: SENDER — the on-chain payer must be the wallet on the record.
            if (record.wallet_address && matchedEvent.user && record.wallet_address.toLowerCase() !== String(matchedEvent.user).toLowerCase()) {
                await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'SENDER_MISMATCH', api_response: `Event payer ${matchedEvent.user} != record wallet ${record.wallet_address}` }).eq('tx_hash', txHash);
                try { await sendTelegramAlert(`🛑 *WEBHOOK BLOCKED: SENDER MISMATCH*\nOn-chain payer doesn't match the pending record's wallet.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
                return NextResponse.json({ status: "Sender mismatch. Blocked." }, { status: 200 });
            }

            // 🔐 CROSS-CHECK 2: TOKEN — the token transferred must be the token on the record.
            const expectedToken = resolveTokenOnChain(record.token_used || 'USD₮', record.blockchain || 'CELO', isMainnet);
            if (expectedToken && matchedEvent.token && String(matchedEvent.token).toLowerCase() !== expectedToken.address) {
                await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'TOKEN_MISMATCH', api_response: `Event token ${matchedEvent.token} != expected ${expectedToken.address} (${record.token_used})` }).eq('tx_hash', txHash);
                try { await sendTelegramAlert(`🛑 *WEBHOOK BLOCKED: TOKEN MISMATCH*\nToken paid doesn't match the pending record's token (${record.token_used}).\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
                return NextResponse.json({ status: "Token mismatch. Blocked." }, { status: 200 });
            }

            // 🔐 CROSS-CHECK 3: AMOUNT — the amount paid must cover the recorded amount_usdt.
            if (expectedToken && matchedEvent.amount !== undefined && matchedEvent.amount !== null) {
                try {
                    const paidWei = BigInt(matchedEvent.amount);
                    const requiredWei = parseUnits(Number(record.amount_usdt).toFixed(expectedToken.decimals), expectedToken.decimals);
                    const tolerance = parseUnits("0.01", expectedToken.decimals); // 1-cent rounding grace
                    const shortfall = requiredWei > paidWei ? requiredWei - paidWei : BigInt(0);
                    if (shortfall > tolerance) {
                        await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'AMOUNT_MISMATCH', api_response: `Paid ${paidWei} < required ${requiredWei} (${record.amount_usdt} ${record.token_used})` }).eq('tx_hash', txHash);
                        try { await sendTelegramAlert(`🛑 *WEBHOOK BLOCKED: AMOUNT MISMATCH*\nUser ${record.wallet_address} paid less than the pending record requires.\nRecord: ${record.amount_usdt} ${record.token_used}\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
                        return NextResponse.json({ status: "Amount mismatch. Blocked." }, { status: 200 });
                    }
                } catch (amtErr) {
                    await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'AMOUNT_UNVERIFIABLE', api_response: 'Could not decode/compare event amount' }).eq('tx_hash', txHash);
                    return NextResponse.json({ status: "Amount unverifiable. Blocked." }, { status: 200 });
                }
            }

            // 🔐 CROSS-CHECK 4: ACCOUNT — the accountNumber in the event must match the record.
            // (Only enforced when the contract actually recorded a non-empty accountNumber.)
            if (matchedEvent.accountNumber && record.account_number && String(matchedEvent.accountNumber).trim() !== '' &&
                String(matchedEvent.accountNumber).toLowerCase() !== String(record.account_number).toLowerCase()) {
                await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'ACCOUNT_MISMATCH', api_response: `Event account ${matchedEvent.accountNumber} != record ${record.account_number}` }).eq('tx_hash', txHash);
                try { await sendTelegramAlert(`🛑 *WEBHOOK BLOCKED: ACCOUNT MISMATCH*\nAccount/meter in the on-chain event doesn't match the pending record.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
                return NextResponse.json({ status: "Account mismatch. Blocked." }, { status: 200 });
            }
        } catch (error) {
            console.error("Webhook Viem Fetch Error:", error);
            // If the node hiccups, we shouldn't fail instantly, but we definitely shouldn't vend. 
            // Setting back to PENDING allows a retry or manual review.
            await supabaseAdmin.from('transactions').update({ status: 'PENDING' }).eq('tx_hash', txHash);
            return NextResponse.json({ status: "Node Error. Reverted to Pending." });
        }


        console.log(`🚀 Triggering VTPass for: ${record.account_number} on ${record.blockchain}`);

        // 3. CONSTRUCT VTPASS PAYLOAD
        const isForeign = record.service_id === 'foreign-airtime';
        const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
        const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

        // ⚡ VTPASS AMOUNT & PHONE LOGIC FIX
        // Admin gets the SMS receipt for international transactions
        const safeAmount = isForeign ? parseFloat(record.foreign_amount || record.foreignAmount || "1") : record.amount_naira;
        const safePhone = isForeign ? "08168811821" : (record.phone || record.account_number);

        let vtpassPayload: any = {
            request_id: record.request_id,
            serviceID: record.service_id, 
            amount: safeAmount,
            phone: safePhone
        };

        if (isForeign) {
            vtpassPayload.billersCode = record.account_number;
            vtpassPayload.variation_code = record.variation_code;
            vtpassPayload.operator_id = record.operator_id?.toString();       // ⚡ REQUIRED STRING
            vtpassPayload.country_code = record.country_code;
            vtpassPayload.product_type_id = record.product_type_id?.toString(); // ⚡ REQUIRED STRING
            vtpassPayload.email = record.customer_email || "support@abapays.com";
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

        // 4. EXECUTE VENDING
        let payRes, payData;
        try {
            payRes = await fetch(`${baseUrl}/pay`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(vtpassPayload) });
            payData = await payRes.json();
        } catch (e: any) {
            // ⚡ DASHBOARD FIX: FAILED_VENDING
            await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: '502_TIMEOUT', api_response: e.message || 'Fetch failed entirely' }).eq('tx_hash', txHash);
            try { await sendTelegramAlert(`❌ *NETWORK CRASH (LIVE)*\n⛓️ *Chain:* ${record.blockchain}\n🛒 *Product:* ${record.network} ${record.service_category}\n👤 *User:* ${record.account_number}\n⚠️ Connection to VTpass timed out.\n🔍 *Explorer:* ${explorerUrl}`); } catch (err) {}
            return NextResponse.json({ status: "Vending Failed (Network)" }, { status: 200 }); 
        }

        // 5. HANDLE SUCCESS / PENDING (000 or 099)
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

                // ⚡ AWAIT TELEGRAM SO IT DOESN'T GET KILLED BY VERCEL ⚡
                try {
                    // ⚡ UPDATED: Display Foreign Amount for Intl
                    await sendTelegramAlert(`✅ *SALE SUCCESSFUL (WEBHOOK)*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n💰 *Amount Paid:* ${record.display_amount || record.displayAmount || `₦${record.amount_naira}`}\n🪙 *Asset:* ${record.amount_usdt} ${record.token_used || 'USD₮'}\n👤 *User:* ${record.account_number}\n🧾 *Ref:* ${alertTokenRef}\n🔍 *Explorer:* ${explorerUrl}`);
                } catch (tgError) {
                    console.error("Telegram Success Alert Error in Webhook:", tgError);
                }

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
                        // ⚡ Uses the SHARED premium template. Previously this path sent a
                        // stripped-down email, so whenever the webhook (rather than the
                        // frontend) completed the vend, the user got a plain receipt.
                        html: buildReceiptEmail({
                            displayAmount: record.display_amount || `₦${Number(record.amount_naira).toLocaleString()}`,
                            serviceLabel: `${record.network || ''} ${record.service_category || ''}`.trim(),
                            accountNumber: record.account_number,
                            cryptoCharged: `${record.amount_usdt} ${record.token_used || 'USD₮'}`,
                            txHash: txHash,
                            purchasedCode: dbPurchasedCode,
                            units: vendedUnits ? String(vendedUnits) : null,
                            referenceId: record.request_id,
                            customerName: record.customer_name,
                            customerAddress: record.customer_address,
                        })
                    }));
                }

                // ⚡ EXCLUDES FEE: Reverse engineers the exact checkout rate to strip the fee
                const effectiveRate = (record.amount_naira + record.fee_naira) / record.amount_usdt;
                const points = Number((record.amount_naira / effectiveRate).toFixed(2));

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

            // ⚡ DASHBOARD FIX: FAILED_VENDING
            await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: payData.code, api_response: rawTechnicalError }).eq('tx_hash', txHash);

            // ⚡ WRAP IN TRY/CATCH SO TELEGRAM ERRORS DON'T CRASH THE WEBHOOK ⚡
            try {
                await sendTelegramAlert(`❌ *VENDING REJECTED (WEBHOOK)*\n⛓️ *Chain:* ${record.blockchain || 'CELO'}\n🛒 *Product:* ${record.network} ${record.service_category}\n👤 *User:* ${record.account_number}\n🚨 *Admin Error:* Code ${payData.code} - ${rawTechnicalError}\n🗣 *User Message:* ${friendlyMessage}\n🔍 *Explorer:* ${explorerUrl}`);
            } catch (tgError) {
                console.error("Telegram Failure Alert Error in Webhook:", tgError);
            }

            return NextResponse.json({ status: "Vending Rejected" }, { status: 200 });  
        }

    } catch (error: any) {
        console.error("Webhook System Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
