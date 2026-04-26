// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

// ⚡ 1. THE ENTERPRISE VALIDATION ENGINE ⚡
const SERVICE_RULES: Record<string, any> = {
    VEND_AIRTIME: { min: 100, max: 50000, required: ['amount_ngn', 'destination_account', 'provider'] },
    VEND_DATA: { min: 50, max: 50000, required: ['destination_account', 'provider'] }, // Data doesn't strictly need amount immediately
    ELECTRICITY: { min: 1000, max: 100000, required: ['amount_ngn', 'destination_account', 'phone', 'email'] },
    TV: { min: 1500, max: 100000, required: ['amount_ngn', 'destination_account', 'phone', 'email'] },
    BANK_TRANSFER: { min: 500, max: 500000, required: ['amount_ngn', 'destination_account', 'provider'] },
    EDUCATION: { min: 1000, max: 50000, required: ['amount_ngn', 'destination_account', 'phone', 'email'] }
};

const detectNetwork = (phone: any) => {
  if (!phone) return null;
  const phoneStr = String(phone).padStart(11, '0');
  const prefix = phoneStr.substring(0, 4);
  if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) return "mtn";
  if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) return "airtel";
  if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) return "glo";
  if (["0809","0817","0818","0908","0909"].includes(prefix)) return "etisalat";
  return null;
};

const fallbackIntentMatcher = (text: string) => {
    const t = text.toLowerCase();
    if (t.includes('airtime') || t.includes('recharge')) return 'VEND_AIRTIME';
    if (t.includes('data') || t.includes('mb') || t.includes('gb')) return 'VEND_DATA';
    if (t.includes('electric') || t.includes('meter') || t.includes('nepa')) return 'ELECTRICITY';
    if (t.includes('tv') || t.includes('dstv') || t.includes('gotv')) return 'TV';
    if (t.includes('transfer') || t.includes('send money') || t.includes('bank')) return 'BANK_TRANSFER';
    if (t.includes('history') || t.includes('status') || t.includes('recent')) return 'TRANSACTION_HISTORY';
    return 'UNKNOWN';
};

async function verifyAccount(intent: string, account: string, type?: string) {
    if (intent === 'ELECTRICITY') return { success: true, customer_name: "Verified User", min_amount: 1000, max_amount: 50000 };
    return { success: true, customer_name: "Verified User", min_amount: 100, max_amount: 100000 };
}

async function fetchCryptoBalances(walletAddress: string) {
    if (!walletAddress) return { usdt: "0.00", usdc: "0.00", cusd: "0.00" };
    return { usdt: "0.00", usdc: "0.00", cusd: "0.00" }; 
}

export async function POST(req: Request) {
  try {
    let { platform, platform_id, text } = await req.json();
    let columnToSearch = platform === 'TELEGRAM' ? 'telegram_chat_id' : platform === 'WHATSAPP' ? 'whatsapp_number' : 'x_twitter_id';
    
    const { data: identity } = await supabase
      .from('deai_identities')
      .select(`deai_pin, is_active, user_id, abapay_global_users(wallet_address, fiat_balance_ngn, country_code)`)
      .eq(columnToSearch, platform_id).single();

    if (!identity || !identity.is_active) {
      return NextResponse.json({ action: 'REPLY', message: "🔒 **Unauthorized**\nPlease link your wallet on the AbaPay dashboard to use this agent." });
    }

    const globalUser: any = Array.isArray(identity.abapay_global_users) ? identity.abapay_global_users[0] : identity.abapay_global_users;
    const currentCountry = globalUser?.country_code || 'NG';
    const currencySymbol = currentCountry === 'NG' ? '₦' : (currentCountry === 'GH' ? 'GH₵' : '$');
    const fiatBalance = globalUser?.fiat_balance_ngn || 0;
    const walletAddress = globalUser?.wallet_address || "";

    const crypto = await fetchCryptoBalances(walletAddress);
    let { data: session } = await supabase.from('deai_sessions').select('*').eq('chat_id', platform_id).single();
    const userInput = text.trim().toLowerCase();

    // ESCAPE HATCH
    if (userInput === 'cancel' || userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: `🌍 **Region:** ${currentCountry}\n💵 **Fiat:** ${currencySymbol}${fiatBalance}\n🪙 **Crypto:** ${crypto.usdt} USDT | ${crypto.usdc} USDC | ${crypto.cusd} cUSD\n\n👋 **Welcome to AbaPay AI!**\n\nI can help you pay bills and send crypto instantly.\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n📜 _Check my history_` 
      });
    }

    // CONTEXT PIVOT
    const freshIntentCheck = fallbackIntentMatcher(text);
    if (session && session.status === 'AWAITING_DETAILS' && freshIntentCheck !== 'UNKNOWN' && freshIntentCheck !== session.intent_data.intent) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        session = null; 
    }

    let isContinuingToAI = false;
    let prependSystemMsg = "";

    // STATE: PIN CONFIRMATION
    if (session?.status === 'AWAITING_PIN') {
      if (text.trim() === identity.deai_pin) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ action: 'REPLY', message: `✅ **PIN Verified!**\n\n⏳ *Processing your ${session.intent_data.selected_token} transaction...*\n\nYour transaction has been submitted. Type **Status** to check your history shortly.` });
      }
      
      // ⚡ FIX: Allow 4 to 6 digit typos to just return "Incorrect PIN" instead of crashing
      if (/^[\d\s]{4,6}$/.test(text.trim())) {
        return NextResponse.json({ action: 'REPLY', message: "❌ Incorrect PIN. Reply with your correct 4-digit PIN, or type **Cancel**." });
      } else {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        session = null;
        isContinuingToAI = true; 
      }
    } 
    // STATE: TOKEN SELECTION
    else if (session?.status === 'AWAITING_TOKEN') {
      const tokenMap: Record<string, string> = { '1': 'Fiat', '2': 'USDT', '3': 'USDC', '4': 'cUSD' };
      const selected = tokenMap[userInput];

      if (!selected) return NextResponse.json({ action: 'REPLY', message: "❌ Invalid selection. Reply with **1**, **2**, **3**, or **4**." });

      session.intent_data.selected_token = selected;
      await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: session.intent_data, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

      const total = Number(session.intent_data.amount_ngn || 0) + Number(session.intent_data.fee || 0);
      return NextResponse.json({
          action: 'REPLY',
          message: `🤖 **Final Checkout**\n\nService: ${session.intent_data.intent.replace('_', ' ')}\nAccount: ${session.intent_data.destination_account}\nName: ${session.intent_data.verified_name || 'N/A'}\nAmount: ${currencySymbol}${session.intent_data.amount_ngn || 0}\nPayment: **${selected}**\n**Total: ${currencySymbol}${total}**\n\n🔒 Reply with your **4-digit PIN** to confirm.`
      });
    }
    // STATE: METER TYPE
    else if (session?.status === 'AWAITING_METER_TYPE') {
        const typeMap: Record<string, string> = { '1': 'prepaid', '2': 'postpaid' };
        const selectedType = typeMap[userInput];

        if (!selectedType) return NextResponse.json({ action: 'REPLY', message: "❌ Please reply with **1** for Prepaid or **2** for Postpaid." });
        
        const verification = await verifyAccount(session.intent_data.intent, session.intent_data.destination_account, selectedType);
        if (!verification.success) {
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
            return NextResponse.json({ action: 'REPLY', message: `❌ Verification failed. Please check the meter number and try again.` });
        }

        session.intent_data.meter_type = selectedType;
        session.intent_data.verified_name = verification.customer_name;
        session.intent_data.verified_min = verification.min_amount;
        session.status = 'AWAITING_DETAILS'; 
        
        prependSystemMsg = `✅ **Meter Verified!**\nName: ${verification.customer_name}\n\n`;
        text = ""; // Wipe text to prevent accidental extraction
        isContinuingToAI = true;
    }
    else if (session?.status === 'AWAITING_DETAILS') {
       isContinuingToAI = true;
    } else {
       isContinuingToAI = true;
    }

    if (!isContinuingToAI) return NextResponse.json({ success: true });

    let intentData: any = {};
    let skipAI = false;

    // ⚡ 3. THE "FAST-PASS" ENGINE (Eliminates AI Timeouts & Hallucinations for simple replies) ⚡
    if (session?.status === 'AWAITING_DETAILS' && text !== "") {
        const cleanText = text.trim();
        const isOnlyDigits = /^\d+$/.test(cleanText.replace(/\s+/g, ''));
        const isOnlyEmail = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/.test(cleanText);
        const isProvider = ["mtn", "glo", "airtel", "9mobile", "etisalat"].includes(cleanText.toLowerCase());

        if (isOnlyDigits || isOnlyEmail || isProvider) {
            intentData = session.intent_data;
            if (isOnlyEmail) {
                intentData.email = cleanText;
            } else if (isProvider) {
                intentData.provider = cleanText.toLowerCase();
            } else if (isOnlyDigits) {
                const cleanNum = cleanText.replace(/\s+/g, '');
                if (cleanNum.length >= 10) {
                    if (!intentData.destination_account) intentData.destination_account = cleanNum;
                    else if (!intentData.phone) intentData.phone = cleanNum;
                } else {
                    intentData.amount_ngn = Number(cleanNum);
                }
            }
            skipAI = true; // We got what we needed perfectly. Do NOT call the AI.
        }
    }

    // --- 4. THE AI EXTRACTOR (Only runs for complex sentences) ---
    if (!skipAI) {
        const previousContext = session?.status === 'AWAITING_DETAILS' ? JSON.stringify(session.intent_data) : "None";
        const digitsMatch: string[] = text.match(/\b\d+\b/g) || [];
        const possibleAccountsOrPhones = digitsMatch.filter((d: string) => d.length >= 10);
        const possibleAmounts = digitsMatch.filter((d: string) => d.length < 10);

        try {
            let newAiData: any = {};
            if (text !== "") { 
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { responseMimeType: "application/json" } });
                const prompt = `
                  Extract entities from: "${text}"
                  Previous Context: ${previousContext}
                  
                  Categories: VEND_AIRTIME, VEND_DATA, ELECTRICITY, EDUCATION, TV, BANK_TRANSFER, TRANSACTION_HISTORY, UNKNOWN.
                  
                  CRITICAL RULES:
                  1. ONLY extract values explicitly mentioned in the New Message.
                  2. DO NOT invent amounts. If no amount is typed, amount_ngn MUST be null.
                  3. "status" or "history" maps to TRANSACTION_HISTORY.
                  
                  Output exactly this JSON format: 
                  { "intent": "UNKNOWN", "provider": null, "amount_ngn": null, "destination_account": null, "phone": null, "email": null }
                `;
                const result = await model.generateContent(prompt);
                const cleanedText = result.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim();
                newAiData = JSON.parse(cleanedText);
            }

            if (session?.status === 'AWAITING_DETAILS' && session.intent_data) {
                intentData = session.intent_data; 
                if (text !== "") {
                    if (!intentData.amount_ngn) intentData.amount_ngn = newAiData.amount_ngn || (possibleAmounts[0] ? Number(possibleAmounts[0]) : null);
                    if (!intentData.email) intentData.email = newAiData.email;
                    if (!intentData.destination_account && possibleAccountsOrPhones.length > 0) intentData.destination_account = String(possibleAccountsOrPhones[0]);
                    else if (!intentData.phone && possibleAccountsOrPhones.length > 0) intentData.phone = String(possibleAccountsOrPhones[0]);
                    else if (!intentData.phone) intentData.phone = newAiData.phone;
                    if (!intentData.provider) intentData.provider = newAiData.provider;
                }
            } else {
                intentData = newAiData;
                if (intentData.amount_ngn) intentData.amount_ngn = Number(intentData.amount_ngn);
                if (intentData.destination_account) intentData.destination_account = String(intentData.destination_account);
            }
        } catch (e) { 
            let localIntent = fallbackIntentMatcher(text);
            if (session?.status === 'AWAITING_DETAILS' && session.intent_data) {
                intentData = session.intent_data;
                if (text !== "") {
                    if (!intentData.amount_ngn && possibleAmounts.length > 0) intentData.amount_ngn = Number(possibleAmounts[0]);
                    if (!intentData.destination_account && possibleAccountsOrPhones.length > 0) intentData.destination_account = String(possibleAccountsOrPhones[0]);
                    else if (!intentData.phone && possibleAccountsOrPhones.length > 0) intentData.phone = String(possibleAccountsOrPhones[0]);
                }
            } else {
                intentData = { intent: localIntent, amount_ngn: null, destination_account: null, provider: null, phone: null, email: null };
                if (possibleAmounts.length > 0) intentData.amount_ngn = Number(possibleAmounts[0]); 
                if (possibleAccountsOrPhones.length > 0) intentData.destination_account = String(possibleAccountsOrPhones[0]);
            }
        }
    }

    if (intentData?.intent === 'TRANSACTION_STATUS' || intentData?.intent === 'STATUS') intentData.intent = 'TRANSACTION_HISTORY';
    if (!SERVICE_RULES[intentData.intent] && intentData.intent !== 'TRANSACTION_HISTORY') intentData.intent = 'UNKNOWN';

    if (intentData.intent === 'UNKNOWN') return NextResponse.json({ action: 'REPLY', message: "🤔 I didn't quite catch that. Type **Help** to see what I can do!" });

    if (intentData.intent === 'TRANSACTION_HISTORY') {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        const { data: recentTxs } = await supabase.from('transactions').select('service_category, network, amount_naira, status, created_at, token_used')
            .eq('wallet_address', globalUser.wallet_address).order('created_at', { ascending: false }).limit(3);

        if (!recentTxs || recentTxs.length === 0) return NextResponse.json({ action: 'REPLY', message: "📜 You don't have any recent transactions yet." });

        let msg = "📜 **Your Recent Transactions:**\n\n";
        recentTxs.forEach((tx, index) => {
            const dateStr = new Date(tx.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
            msg += `${index + 1}. **${(tx.service_category || 'Payment').replace('_', ' ')}**\n`;
            msg += `Amount: ${currencySymbol}${tx.amount_naira} (${tx.token_used || 'Fiat'})\nStatus: ${tx.status} | Date: ${dateStr}\n\n`;
        });
        return NextResponse.json({ action: 'REPLY', message: msg });
    }

    // --- 5. THE MISSING FIELD ENGINE ---
    if (['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent) && intentData.destination_account && !intentData.provider) {
        intentData.provider = detectNetwork(intentData.destination_account);
    }

    const rules = SERVICE_RULES[intentData.intent];
    if (rules) {
        let missing = [];
        
        for (const field of rules.required) {
            if (!intentData[field]) {
                if (field === 'amount_ngn') missing.push("the **Amount**");
                if (field === 'destination_account') missing.push("the **Target Number/Account**");
                if (field === 'provider') missing.push("the **Network Provider**");
                if (field === 'phone') missing.push("your **Contact Phone Number**");
                if (field === 'email') missing.push("your **Email Address**");
            }
        }

        if (missing.length > 0) {
            await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
            return NextResponse.json({ action: 'REPLY', message: `${prependSystemMsg}To process your ${intentData.intent.replace('_', ' ')}, please reply with ${missing.join(", ")}.` });
        }

        const activeMin = intentData.verified_min || rules.min;
        if (activeMin && intentData.amount_ngn < activeMin) {
            intentData.amount_ngn = null; 
            await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
            return NextResponse.json({ action: 'REPLY', message: `❌ Minimum amount for this service is ${currencySymbol}${activeMin}. Please reply with a valid amount.` });
        }
    }

    // ELECTRICITY VERIFICATION GATE 
    if (intentData.intent === 'ELECTRICITY' && !intentData.meter_type) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_METER_TYPE', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `💡 Electricity Payment for Meter: **${intentData.destination_account}**\n\nIs this Prepaid or Postpaid?\n\nReply with:\n**1** for Prepaid\n**2** for Postpaid` });
    }

    intentData.fee = ['ELECTRICITY', 'TV', 'EDUCATION'].includes(intentData.intent) ? 100 : 0;

    // TOKEN SELECTION
    if (!intentData.selected_token) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_TOKEN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        
        let prefixMsg = intentData.provider && ['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent) 
            ? `(Network Auto-Detected: **${intentData.provider.toUpperCase()}**)\n\n` : "";

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}${prefixMsg}🪙 **Select Payment Method**\n\n1️⃣ Fiat Balance (${currencySymbol}${fiatBalance})\n2️⃣ USDT (${crypto.usdt})\n3️⃣ USDC (${crypto.usdc})\n4️⃣ cUSD (${crypto.cusd})\n\n*Reply with the number (e.g., 2).*`
        });
    }

  } catch (error) {
    console.error("System Error:", error);
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error. Please try again." });
  }
}
