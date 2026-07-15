import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { createPublicClient, http, decodeFunctionData, parseUnits } from 'viem';
import { base, baseSepolia, celo, celoSepolia } from 'viem/chains';

const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { 
      serviceID, serviceCategory, network, billersCode, amount, 
      token: tokenSymbol, txHash, variation_code, phone, 
      nairaAmount, foreignAmount, displayAmount, wallet_address, subscription_type, // ⚡ ADDED foreignAmount & displayAmount
      operator_id, country_code, product_type_id, email,
      meter_account_type, blockchain,
      customer_name, customer_address, // ⚡ From VTpass merchant-verify (electricity/bank)
      source_channel,                  // ⚡ WEB | TELEGRAM | WHATSAPP | X | SCHEDULE
      intent_only, preflight_hash, cancel_intent 
    } = body;

    // ⚡ FIX 1: INSTANT CANCELLATION INTERCEPTOR ⚡
    if (cancel_intent) {
        const hashToDelete = preflight_hash || txHash;
        await supabase.from('transactions').delete().eq('tx_hash', hashToDelete);
        return NextResponse.json({ success: true, status: "CANCELLED" });
    }

    const requestedNaira = parseFloat(nairaAmount);
    const isForeign = serviceID === 'foreign-airtime';
    const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
    const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
    const vendAmount = requestedNaira; 
    const vtRequestId = getStrictRequestId();

    // ⚡ SMART EXPLORER URL GENERATOR ⚡
    const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "mainnet" || process.env.NEXT_PUBLIC_NETWORK === "celo" || process.env.NEXT_PUBLIC_NETWORK === "base";
    let explorerBase = isMainnet ? "https://celoscan.io" : "https://alfajores.celoscan.io";
    if (blockchain === 'BASE') {
        explorerBase = isMainnet ? "https://basescan.org" : "https://sepolia.basescan.org";
    }
    const explorerUrl = `${explorerBase}/tx/${txHash}`;

    // 1. RATE VERIFICATION (Security Check)
    const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
    const baseRate = parseFloat(settingsData?.exchange_rate || "1500");
    const requiredCrypto = (vendAmount + serviceFee) / baseRate;

    if (parseFloat(amount) < parseFloat(requiredCrypto.toFixed(4))) {
        return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Insufficient crypto paid." }, { status: 400 });
    }

    // 2. THE SAFETY NET / ATOMIC LOCK
    const dbPayload = {
      tx_hash: txHash, request_id: vtRequestId, service_category: serviceCategory, service_id: serviceID, variation_code: variation_code, network: network, 
      blockchain: blockchain || "CELO", account_number: billersCode || phone || "N/A", phone: phone || null, amount_usdt: parseFloat(amount), 
      amount_naira: vendAmount, fee_naira: serviceFee, status: 'PENDING', wallet_address: (wallet_address || "UNKNOWN").toLowerCase(),
      customer_name: customer_name || null, customer_address: customer_address || null,
      source_channel: source_channel || 'WEB',
      token_used: tokenSymbol, meter_account_type: meter_account_type || null, customer_email: email || null,
      operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null, subscription_type: subscription_type || null,
      foreign_amount: foreignAmount || null, display_amount: displayAmount || null // ⚡ Save for background webhook use
    };

    if (intent_only) {
        await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });
        return NextResponse.json({ success: true, status: "PENDING" });
    }

    if (preflight_hash) {
        await supabase.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', preflight_hash);
    }

    // 3. ON-CHAIN VERIFICATION (Smart Wallet & Payload Tamper Check)
    try {
        const activeChain = blockchain === 'BASE' ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);

        let rpcUrl = activeChain.rpcUrls.default.http[0];
        if (activeChain.id === celo.id) rpcUrl = "https://forno.celo.org";
        if (activeChain.id === base.id) rpcUrl = "https://mainnet.base.org";

        const publicClient = createPublicClient({ chain: activeChain, transport: http(rpcUrl) });

        const receipt = await publicClient.waitForTransactionReceipt({ 
            hash: txHash as `0x${string}`,
            confirmations: 1,
            timeout: 60000 
        });

        if (receipt.status !== 'success') {
            await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: 'REVERTED', api_response: 'Transaction failed on-chain' }).eq('tx_hash', txHash);
            await sendTelegramAlert(`🛑 *DOUBLE SPEND BLOCKED*\nUser ${wallet_address} tried to use a failed/reverted transaction!\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
            return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Transaction failed on the blockchain. Your funds were not deducted." }, { status: 400 });
        }

        const expectedContract = blockchain === 'BASE' 
            ? (process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS)
            : (process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS);

        const txTo = receipt.to?.toLowerCase() || "";
        const expectedLower = expectedContract?.toLowerCase() || "";
        let isSmartWallet = false;

        if (txTo !== expectedLower) {
            const entryPoints = [ "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032" ];
            if (entryPoints.includes(txTo)) {
                isSmartWallet = true;
            } else {
                 await sendTelegramAlert(`🚨 *FRAUD ATTEMPT DETECTED*\nUser ${wallet_address} submitted a txHash sent to the wrong contract.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Invalid contract destination." }, { status: 400 });
            }
        }

        if (!isSmartWallet) {
            const transaction = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
            if (!transaction.input) return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "No contract data found." }, { status: 400 });

            const decoded = decodeFunctionData({ abi: ABAPAY_ABI, data: transaction.input });
            if (!decoded.args || decoded.args.length < 4) return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Invalid contract payload structure." }, { status: 400 });

            const chainServiceType = decoded.args[1] as string;
            const chainAccountNumber = decoded.args[2] as string;
            const chainAmountWei = decoded.args[3] as bigint;
            const expectedAccount = billersCode || phone;

            if (chainServiceType !== serviceID || chainAccountNumber !== expectedAccount) {
                await sendTelegramAlert(`🚨 *TAMPERING BLOCKED*\nUser ${wallet_address} altered the payload!\nChain Service: ${chainServiceType} | Requested: ${serviceID}\nChain Account: ${chainAccountNumber} | Requested: ${expectedAccount}\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Payload mismatch detected." }, { status: 400 });
            }

            const tokenDecimals = (tokenSymbol === 'cUSD' || tokenSymbol === 'USDm') ? 18 : 6;
            const expectedWei = parseUnits(amount.toString(), tokenDecimals);
            const diff = chainAmountWei > expectedWei ? chainAmountWei - expectedWei : expectedWei - chainAmountWei;

            if (diff > BigInt(10)) {
                 await sendTelegramAlert(`🚨 *AMOUNT TAMPERING BLOCKED*\nUser ${wallet_address} altered the price payload.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Amount mismatch detected." }, { status: 400 });
            }
        } else {
            const paddedExpectedContract = "0x000000000000000000000000" + expectedLower.substring(2);
            // Find the ERC-20 Transfer log whose recipient (topic[2]) is the AbaPay contract.
            const transferLog = receipt.logs.find((log: any) => log.topics && log.topics.length >= 3 && log.topics[2]?.toLowerCase() === paddedExpectedContract);

            if (!transferLog) {
                 await sendTelegramAlert(`🚨 *SMART WALLET FRAUD DETECTED*\nFunds did not reach AbaPay contract.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                 return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Funds not received." }, { status: 400 });
            }

            // 🔐 AMOUNT ENFORCEMENT FOR SPONSORED/SMART-WALLET PATH
            // The transfer amount is the non-indexed `value` in the log data. Previously this
            // path confirmed only that *a* transfer happened — not how much — which let a
            // sponsored/smart-wallet user pay a trivial amount and request a large vend.
            try {
                const tokenDecimals = (tokenSymbol === 'cUSD' || tokenSymbol === 'USDm') ? 18 : 6;
                const paidWei = BigInt(transferLog.data as string);
                const requiredWei = parseUnits(requiredCrypto.toFixed(tokenDecimals), tokenDecimals);
                // Allow a tiny rounding tolerance (matches the EOA path's philosophy).
                const shortfall = requiredWei > paidWei ? requiredWei - paidWei : BigInt(0);
                const tolerance = parseUnits("0.01", tokenDecimals); // 1 cent grace for rounding
                if (shortfall > tolerance) {
                    await sendTelegramAlert(`🚨 *SPONSORED UNDERPAYMENT BLOCKED*\nUser ${wallet_address} paid less than required via smart wallet.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Amount mismatch detected." }, { status: 400 });
                }
            } catch (amountErr) {
                await sendTelegramAlert(`🚨 *SPONSORED AMOUNT UNVERIFIABLE*\nCould not decode transfer amount — refusing to vend.\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
                return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: "Could not verify payment amount." }, { status: 400 });
            }
        }
    } catch (error) {
        return NextResponse.json({ success: true, status: 'TIMEOUT', message: "Transaction verifying in background." });
    }

    // 4. ATOMIC LOCK
    const { data: lockedRecord, error: lockError } = await supabase
      .from('transactions')
      .update({ status: 'PROCESSING', request_id: vtRequestId })
      .eq('tx_hash', txHash) 
      .eq('status', 'PENDING')
      .select()
      .single();

    if (!lockedRecord || lockError) {
        return NextResponse.json({ success: true, status: "TIMEOUT", message: "Vending handled by background webhook." });
    }

    // 5. VEND (shared with the x402 settlement path — see src/lib/vend.ts)
    const vendResult = await executeVend({
        vtRequestId, txHash, serviceID, serviceCategory, network, billersCode, phone,
        variation_code, subscription_type, amount, tokenSymbol, vendAmount, displayAmount,
        foreignAmount, isForeign, operator_id, country_code, product_type_id, email,
        wallet_address, blockchain, source_channel, customer_name, customer_address,
        baseRate, explorerUrl,
    });

    return NextResponse.json(vendResult);

  } catch (error: any) {
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: "System error recording transaction." }, { status: 500 });
  }
}
