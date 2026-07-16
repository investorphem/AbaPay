// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { parseIntent } from '@/lib/deai/intentEngine';
import { verifyAccount as realVerifyAccount, fetchDataVariations as realFetchDataVariations, fetchCryptoBalances as realFetchCryptoBalances, resolveServiceId } from '@/lib/deai/services';
import { createDeepLink } from '@/lib/deai/deeplink';
import { relayPayBillFor, getRemainingAllowance } from '@/lib/deai/relayer';
import { checkServiceAllowed, checkAgentSpendAllowed } from '@/lib/serviceRules';
import { assessFeasibility, describeCapabilities, getCapability, capabilityForIntent } from '@/lib/deai/capabilities';
import { checkParity, checkAccountNumber, checkAmount as checkAmountParity, isDuplicateElectricity, formatConversion, REQ, requiresVariation, supportsRenew, requiresVerifiedName } from '@/lib/parity';
import { sendTelegramAlert } from '@/lib/telegram';
import { checkPinAllowed, recordPinFailure, clearPinFailures, notifySpendOutOfBand } from '@/lib/deai/pinSecurity';
import { SUPPORTED_TOKENS } from '@/constants';
import { providersFor, renderOptions, matchProvider, needsVariation, variationServiceId, fetchVariations, matchVariation, groupDataPlans, renderCategoryMenu, matchCategory } from '@/lib/deai/selection';
import { createClient } from '@supabase/supabase-js';
import { verifyInternalRequest } from '@/utils/internalAuth';
import { verifyPin, isHashedPin, hashPin } from '@/utils/pinSecurity';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

// ⚡ 1. THE ENTERPRISE VALIDATION ENGINE ⚡
const SERVICE_RULES: Record<string, any> = {
    VEND_AIRTIME: { min: 100, max: 50000, required: ['amount_ngn', 'destination_account', 'provider'] },
    VEND_DATA: { min: 50, max: 50000, required: ['destination_account', 'provider'] },
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
    if (t.includes('tv') || t.includes('dstv') || t.includes('gotv') || t.includes('cable')) return 'TV';
    if (t.includes('transfer') || t.includes('send money') || t.includes('bank')) return 'BANK_TRANSFER';
    if (t.includes('education') || t.includes('waec') || t.includes('jamb') || t.includes('school')) return 'EDUCATION';
    if (t.includes('history') || t.includes('status') || t.includes('recent')) return 'TRANSACTION_HISTORY';
    return 'UNKNOWN';
};

// ⚡ INDESTRUCTIBLE REGEX SWEEP ⚡
function extractEntities(text: string, currentData: any = {}) {
    let data = { ...currentData };
    const cleanText = text.trim().toLowerCase();
    
    // 1. Force Extract Email
    const extractedEmail = cleanText.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/)?.[0];
    if (extractedEmail && !data.email) data.email = extractedEmail;
    
    // 2. Force Extract Provider
    const providers = ["mtn", "glo", "airtel", "9mobile", "etisalat", "dstv", "gotv", "startimes", "ikeja", "ibadan", "eko", "abuja"];
    const foundProvider = providers.find(p => cleanText.includes(p));
    if (foundProvider && !data.provider) data.provider = foundProvider;

    // 3. Force Extract Digits
    const digitsMatch = cleanText.match(/\b\d+\b/g) || [];
    const possibleAccountsOrPhones = digitsMatch.filter(d => d.length >= 10);
    const possibleAmounts = digitsMatch.filter(d => d.length >= 2 && d.length < 10);

    if (possibleAmounts.length > 0 && !data.amount_ngn) data.amount_ngn = Number(possibleAmounts[0]);
    
    if (possibleAccountsOrPhones.length > 0) {
        if (!data.destination_account) {
            data.destination_account = possibleAccountsOrPhones[0];
            if (possibleAccountsOrPhones.length > 1 && !data.phone) data.phone = possibleAccountsOrPhones[1];
        } else if (!data.phone && possibleAccountsOrPhones[0] !== data.destination_account) {
            data.phone = possibleAccountsOrPhones[0];
        } else if (!data.phone && possibleAccountsOrPhones.length > 1) {
            data.phone = possibleAccountsOrPhones[1];
        }
    }
    return data;
}

// ⚡ Which tokens are actually available on a given chain?
// Read from SUPPORTED_TOKENS — the SAME source the web app uses — so the agent can never
// offer a token that doesn't exist on the selected chain (cUSD/USDm is Celo-only).
function tokensForChain(chain: 'CELO' | 'BASE'): string[] {
    const key = chain.toLowerCase();
    return (SUPPORTED_TOKENS as any[])
        .filter((t) => !t.supportedNetworks || t.supportedNetworks.includes(key))
        .map((t) => t.symbol);
}

// Live platform exchange rate (NGN per 1 stablecoin), used to convert a bill into crypto.
async function getExchangeRate(): Promise<number> {
    try {
        const { data } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
        const rate = Number((data as any)?.exchange_rate);
        if (Number.isFinite(rate) && rate > 0) return rate;
    } catch {}
    return Number(process.env.NEXT_PUBLIC_FIXED_RATE) || 1550;
}

// ⚡ REAL IMPLEMENTATIONS (were hardcoded stubs — DeAI was a simulation until now).
// These now hit the same VTpass endpoints and on-chain reads the web app uses.

async function verifyAccount(intent: string, account: string, type?: string, provider?: string | null) {
    const serviceID = resolveServiceId(intent, provider || null);
    if (!serviceID) return { success: false, message: "I couldn't work out which provider that is." };
    return await realVerifyAccount(serviceID, account, type);
}

async function fetchCryptoBalances(walletAddress: string, blockchain = 'CELO') {
    return await realFetchCryptoBalances(walletAddress, blockchain);
}

// ⚡ AbaPay operates on both Celo and Base — a flat balance list with no chain label left
// users unable to tell which chain their funds are actually on. Fetch both and label them.
async function fetchAllChainBalances(walletAddress: string) {
    const [celo, base] = await Promise.all([
        fetchCryptoBalances(walletAddress, 'CELO'),
        fetchCryptoBalances(walletAddress, 'BASE'),
    ]);
    return { celo, base };
}

function formatChainBalances(balances: { celo: Record<string, string>; base: Record<string, string> }): string {
    const celoLine = `⚫ Celo: ${balances.celo['USD₮'] || '0.0000'} USDT | ${balances.celo['USDC'] || '0.0000'} USDC | ${balances.celo['USDm'] || '0.0000'} cUSD`;
    const baseLine = `🔵 Base: ${balances.base['USD₮'] || '0.0000'} USDT | ${balances.base['USDC'] || '0.0000'} USDC`;
    return `${celoLine}\n${baseLine}`;
}

async function fetchDataVariations(provider: string) {
    const plans = await realFetchDataVariations(`${provider.toLowerCase()}-data`);
    return plans.map((p, i) => ({ id: String(i + 1), name: p.name, price: p.price, code: p.code }));
}

export async function POST(req: Request) {
  try {
    // 🔐 INTERNAL ONLY: this route is the DeAI "brain" and must only be reachable
    // via our own bot webhook routes. Without this check, anyone who knows a
    // victim's chat ID / phone number / X ID could impersonate them directly:
    // read their fiat & crypto balances, read their transaction history, and
    // brute-force their 4-digit PIN in unlimited batches.
    if (!verifyInternalRequest(req)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let { platform, platform_id, text } = await req.json();

    // 🔐 INPUT VALIDATION: reject malformed payloads before they touch any logic
    if (typeof text !== 'string' || typeof platform_id !== 'string' || !platform_id || text.length > 1000) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const channel = platform === 'TELEGRAM' ? 'TELEGRAM' : platform === 'WHATSAPP' ? 'WHATSAPP' : 'X';

    // ⚡ LINK-CODE CLAIM ⚡
    // The user links a channel from the APP (where their wallet is), gets a one-time code,
    // and sends it to the bot here. This binds their chat id to their wallet. Works
    // identically for Telegram, WhatsApp, and X.
    const maybeCode = text.trim().toUpperCase();
    if (/^ABA-[A-F0-9]{6}$/.test(maybeCode)) {
      const { data: pendingLink } = await supabase
        .from('agent_links')
        .select('*')
        .eq('link_code', maybeCode)
        .eq('channel', channel)
        .eq('link_verified', false)
        .maybeSingle();

      if (!pendingLink) {
        return NextResponse.json({ action: 'REPLY', message: "❌ That link code isn't valid (or was already used). Generate a fresh one in the AbaPay app." });
      }

      const { error: claimErr } = await supabase
        .from('agent_links')
        .update({ channel_user_id: platform_id, link_verified: true, link_code: null })
        .eq('id', (pendingLink as any).id);

      if (claimErr) {
        console.error('[DeAI] link claim failed:', claimErr.message);
        return NextResponse.json({ action: 'REPLY', message: "⚠️ Couldn't complete linking. Please try again." });
      }

      const w = (pendingLink as any).wallet_address;
      return NextResponse.json({
        action: 'REPLY',
        message: `✅ **Linked!**\n\nWallet: \`${w.slice(0, 6)}...${w.slice(-4)}\`\n\nYou can now pay bills right here — just tell me what you need, then confirm with your PIN.\n\n_Try: "Send 500 airtime to 08012345678"_`,
      });
    }

    // ⚡ IDENTITY RESOLUTION ⚡
    // agent_links is the primary source (channel + chat id -> wallet + PIN, no join needed).
    // We fall back to the legacy deai_identities table so previously-linked users still work.
    let identity: any = null;
    let globalUser: any = null;

    const { data: link } = await supabase
      .from('agent_links')
      .select('*')
      .eq('channel', channel)
      .eq('channel_user_id', platform_id)
      .eq('link_verified', true)
      .maybeSingle();

    if (link && (link as any).is_active) {
      identity = { deai_pin: (link as any).pin_hash, is_active: true, _source: 'agent_links', _linkId: (link as any).id };
      globalUser = {
        wallet_address: (link as any).wallet_address,
        country_code: 'NG',
      };
    } else {
      // Legacy path
      const legacyColumn = platform === 'TELEGRAM' ? 'telegram_chat_id' : platform === 'WHATSAPP' ? 'whatsapp_number' : 'x_twitter_id';
      const { data: legacy } = await supabase
        .from('deai_identities')
        .select(`deai_pin, is_active, user_id, abapay_global_users(wallet_address, fiat_balance_ngn, country_code)`)
        .eq(legacyColumn, platform_id).maybeSingle();

      if (legacy) {
        identity = { ...legacy, _source: 'deai_identities' };
        globalUser = Array.isArray((legacy as any).abapay_global_users)
          ? (legacy as any).abapay_global_users[0]
          : (legacy as any).abapay_global_users;
      }
    }

    if (!identity || !identity.is_active) {
      return NextResponse.json({
        action: 'REPLY',
        message: "🔒 **Not linked yet**\n\nLink this chat to your wallet at https://abapays.com — connect your wallet, choose this platform, set a PIN, and send me the code you get.\n\nOnce linked, you can pay bills right here.",
      });
    }

    const currentCountry = globalUser?.country_code || 'NG';
    const currencySymbol = currentCountry === 'NG' ? '₦' : (currentCountry === 'GH' ? 'GH₵' : '$');
    const fiatBalance = globalUser?.fiat_balance_ngn || 0;
    const crypto = await fetchAllChainBalances(globalUser?.wallet_address || "");

    let { data: session } = await supabase.from('deai_sessions').select('*').eq('chat_id', platform_id).single();
    const userInput = text.trim().toLowerCase();

    // ESCAPE HATCHES
    if (userInput === 'cancel') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ action: 'REPLY', message: "🚫 **Transaction Cancelled.**\n\nType **Start** whenever you are ready to make a new request." });
    }

    if (userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: `🌍 **Region:** ${currentCountry}\n💵 **Fiat:** ${currencySymbol}${fiatBalance}\n🪙 **Crypto:**\n${formatChainBalances(crypto)}\n\n👋 **Welcome to AbaPay AI!**\n\nI can help you pay bills and send crypto instantly.\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n📜 _Check my history_`
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
      // 🔒 LOCKOUT GATE — checked BEFORE we even look at the PIN, so a locked identity
      // cannot keep guessing. Survives session resets.
      if (identity._linkId) {
        const gateCheck = await checkPinAllowed(identity._linkId);
        if (!gateCheck.allowed) {
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
          return NextResponse.json({ action: 'REPLY', message: gateCheck.message! });
        }
      }

      if (verifyPin(text.trim(), identity.deai_pin)) {
        // Correct PIN — wipe the failure counter.
        if (identity._linkId) await clearPinFailures(identity._linkId);

        // 🔐 TRANSPARENT MIGRATION: if this PIN was still stored as legacy
        // plaintext, upgrade it to a salted scrypt hash on this successful login.
        // Write back to whichever table this identity actually came from.
        if (!isHashedPin(identity.deai_pin)) {
          const newHash = hashPin(text.trim());
          if (identity._source === 'agent_links') {
            await supabase.from('agent_links').update({ pin_hash: newHash }).eq('id', identity._linkId);
          } else {
            const legacyColumn = platform === 'TELEGRAM' ? 'telegram_chat_id' : platform === 'WHATSAPP' ? 'whatsapp_number' : 'x_twitter_id';
            await supabase.from('deai_identities').update({ deai_pin: newHash }).eq(legacyColumn, platform_id);
          }
        }
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

        // ⚡ REAL PAYMENT HAND-OFF ⚡
        //
        // This previously replied "Your transaction has been submitted" and then did
        // NOTHING — no payment, no vend. DeAI was a convincing simulation.
        //
        // It can't sign on the user's behalf: AbaPay's contract uses
        // transferFrom(msg.sender, ...), so the payer MUST be the signer, and there is no
        // server-side key for the user (there must never be — that would make us a
        // custodian). So instead the agent hands back a signed, expiring deep link that
        // opens the app with everything pre-filled. The user taps, their own wallet signs,
        // and a REAL payment goes through the same verified pipeline as the web app.
        const d = session.intent_data || {};
        const host = req.headers.get('host');
        const proto = host?.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${proto}://${host}`;

        const serviceLabel = d.intent === 'ELECTRICITY' ? 'Electricity'
                           : d.intent === 'VEND_DATA' ? 'Data'
                           : d.intent === 'TV' ? 'Cable' : 'Airtime';
        const chain = (d.chain || 'CELO').toUpperCase();
        const tokenSym = d.selected_token || 'USD₮';

        // ⚡ PATH A — AUTONOMOUS AGENT PAYMENT (user pre-approved an on-chain allowance)
        //
        // If the user granted an on-chain spending allowance from their own wallet in the
        // app, the agent can pay RIGHT NOW from chat — PIN is the only remaining step.
        //
        // The allowance is enforced BY THE CONTRACT. Even a fully compromised backend
        // cannot exceed the number the user signed for. We still check it here first so we
        // can fail with a helpful message instead of an on-chain revert.
        // 🔴 RULE GATE — the agent is a client like any other; it does NOT skip the rules.
        // This must run BEFORE we spend a single cent. If the operator has disabled this
        // service (provider outage, fraud, dispute), the agent must refuse — exactly as the
        // web app does. Without this, the relayer would spend real user funds on a service
        // that has been deliberately switched off.
        const gate = await checkServiceAllowed(d.intent);
        if (!gate.allowed) {
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
          return NextResponse.json({ action: 'REPLY', message: `⛔ ${gate.reason}` });
        }

        const amountGate = checkAmountParity(d.intent, Number(d.amount_ngn), {
          isFixedPlan: !!d.variation_code,   // a plan's price IS the price — skip min/max
          verifiedMin: d.verified_min,
        });
        if (!amountGate.valid) {
          return NextResponse.json({ action: 'REPLY', message: `⚠️ ${amountGate.error}` });
        }

        // ⚡ OPERATOR GATE — the emergency brake. An operator can halt agent spending
        // instantly from the admin dashboard, and per-tx / per-day caps bound the damage
        // from a compromised PIN or relayer key.
        const spendGate = await checkAgentSpendAllowed(supabase, globalUser?.wallet_address || '', Number(d.amount_ngn));
        if (!spendGate.allowed) {
            // Not fatal — fall through to the deep link so the user can still pay themselves.
            console.log('[DeAI] Agent spend blocked by operator gate:', spendGate.reason);
        }

        const userWallet = spendGate.allowed ? globalUser?.wallet_address : null;
        let relayed = false;

        if (userWallet) {
          try {
            const allowance = await getRemainingAllowance(userWallet, tokenSym, chain);
            const rate = await getExchangeRate();
            const amountCrypto = (Number(d.amount_ngn) / rate).toFixed(6);

            if (allowance.ok && allowance.remaining >= Number(amountCrypto)) {
              const serviceID = resolveServiceId(d.intent, d.provider || null) || d.provider || '';

              const res = await relayPayBillFor({
                userWallet,
                tokenSymbol: tokenSym,
                serviceType: serviceID,
                accountNumber: d.destination_account,
                amountCrypto,
                blockchain: chain,
                sourceChannel: platform,          // TELEGRAM | WHATSAPP | X
                amountNgn: Number(d.amount_ngn),
              });

              if (res.success) {
                relayed = true;
                const left = (allowance.remaining - Number(amountCrypto)).toFixed(2);

                // 🔒 OUT-OF-BAND SPEND ALERT.
                //
                // This is the real defence against someone else having access to the chat:
                // even if an attacker has the PIN, the OWNER is told immediately, by email
                // and on every other linked channel. They can revoke (set limit to 0) before
                // much damage is done. Silence is what turns a small compromise into a large one.
                try {
                  await notifySpendOutOfBand(globalUser?.wallet_address || '', {
                    amountNgn: Number(d.amount_ngn),
                    amountCrypto,
                    token: tokenSym,
                    service: `${d.provider || ''} ${serviceLabel}`,
                    account: d.destination_account,
                    channel: platform,
                    txHash: res.txHash || '',
                    remaining: left,
                  });
                } catch { /* never block a successful payment on alerting */ }

                return NextResponse.json({
                  action: 'REPLY',
                  message: [
                    `✅ **Paid!**`,
                    ``,
                    `**${d.provider || ''} ${serviceLabel}** — ₦${Number(d.amount_ngn).toLocaleString()}`,
                    d.customer_name ? `👤 ${d.customer_name}` : null,
                    `📱 ${d.destination_account}`,
                    `⛓️ ${chain} · ${amountCrypto} ${tokenSym}`,
                    ``,
                    `🔗 \`${res.txHash}\``,
                    ``,
                    `💳 Remaining agent allowance: **${left} ${tokenSym}**`,
                    `_Your token — your wallet. AbaPay never held your funds._`,
                  ].filter(Boolean).join('\n'),
                });
              }

              // Relay failed — fall through to the deep link so the user isn't stuck.
              console.error('[DeAI] Relay failed, falling back to deep link:', res.message);
            }
          } catch (relayErr) {
            console.error('[DeAI] Relay path errored, falling back to deep link:', relayErr);
          }
        }

        // ⚡ PATH B — DEEP-LINK HAND-OFF (no allowance, or relay unavailable)
        // The user signs in the app with their own wallet.
        try {
          const serviceID = resolveServiceId(d.intent, d.provider || null) || d.provider || '';
          const payUrl = createDeepLink(baseUrl, {
            serviceID,
            serviceCategory: d.intent === 'ELECTRICITY' ? 'ELECTRICITY'
                            : d.intent === 'TV' ? 'CABLE'
                            : d.intent === 'VEND_DATA' ? 'DATA' : 'AIRTIME',
            provider: d.provider || '',
            billersCode: d.destination_account,
            amountNgn: Number(d.amount_ngn),
            variationCode: d.variation_code || undefined,
            meterType: d.meter_type || undefined,
            cableAction: d.cable_action || undefined,
            customerName: d.customer_name || undefined,
            customerAddress: d.customer_address || undefined,
            // Honour the chain the user actually chose.
            chain: (d.chain || 'CELO') as 'CELO' | 'BASE',
            token: d.selected_token || 'USD₮',
            channel: platform,
            chatId: platform_id,
          });

          const summary = [
            `✅ **PIN Verified!**`,
            ``,
            `**${d.provider || ''} ${d.intent === 'ELECTRICITY' ? 'Electricity' : d.intent === 'VEND_DATA' ? 'Data' : d.intent === 'TV' ? 'Cable' : 'Airtime'}**`,
            d.customer_name ? `👤 ${d.customer_name}` : null,
            `📱 ${d.destination_account}`,
            `💰 ₦${Number(d.amount_ngn).toLocaleString()}`,
            ``,
            `👉 **[Tap here to approve & pay](${payUrl})**`,
            ``,
            `_You'll sign with your own wallet — AbaPay never holds your funds. Link expires in 15 minutes._`,
          ].filter(Boolean).join('\n');

          return NextResponse.json({ action: 'REPLY', message: summary });
        } catch (linkErr) {
          console.error('[DeAI] Failed to build payment link:', linkErr);
          return NextResponse.json({ action: 'REPLY', message: "⚠️ I couldn't generate your payment link. Please try again, or pay directly at https://abapays.com" });
        }
      } else {
        // 🔴 THE OLD LOGIC WAS A BRUTE-FORCE HOLE:
        //   the counter lived in the SESSION, and after 4 failures it DELETED the session
        //   and said "type Start to begin a new request" — which reset the counter to zero.
        //   An attacker with access to the chat could try 4 PINs, type "Start", try 4 more,
        //   forever. 10,000 combinations. That's not a lockout.
        //
        // The counter now lives on the IDENTITY (agent_links), so it survives session
        // resets, "Start", "Cancel", and anything else the attacker tries.
        const linkId = identity._linkId;

        if (linkId) {
          const result = await recordPinFailure(linkId, platform_id, channel);

          if (!result.allowed) {
            // Locked — wipe the pending transaction too.
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
            return NextResponse.json({ action: 'REPLY', message: result.message! });
          }

          return NextResponse.json({
            action: 'REPLY',
            message: `${result.message}\n\nReply with your PIN to confirm, or type *cancel* to abort.`,
          });
        }

        // Legacy identity (deai_identities) — fall back to the session counter.
        const attempts = (session.intent_data.pin_attempts || 0) + 1;
        if (attempts >= 4) {
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
          return NextResponse.json({ action: 'REPLY', message: "🚫 *Transaction aborted.*\n\nToo many incorrect PINs. This session has been wiped." });
        }
        session.intent_data.pin_attempts = attempts;
        await supabase.from('deai_sessions').update({ intent_data: session.intent_data }).eq('chat_id', platform_id);
        return NextResponse.json({ action: 'REPLY', message: `❌ *Incorrect PIN* (${4 - attempts} attempts left)` });
      }
    } 
    // ⚡ STATE: COLLECTING A COMPULSORY FIELD (phone / email) ⚡
    // Entered when the parity gate found a required field the app would demand.
    else if (session?.status === 'AWAITING_FIELD') {
      const fieldName = session.intent_data.awaiting_field;
      const spec = Object.values(REQ).find((r: any) => r.field === fieldName) as any;

      if (!spec) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ action: 'REPLY', message: "Something went wrong — let's start again." });
      }

      const value = text.trim();
      if (!spec.validate(value)) {
        return NextResponse.json({ action: 'REPLY', message: `⚠️ ${spec.error}\n\n${spec.ask}` });
      }

      session.intent_data[fieldName] = value;
      delete session.intent_data.awaiting_field;

      // Any more compulsory fields still outstanding?
      const isIntl2 = !!(session.intent_data.country && session.intent_data.country !== 'NG');
      const parity2 = checkParity(session.intent_data.intent, session.intent_data, { isInternational: isIntl2 });

      if (parity2.missing.length > 0) {
        const next = parity2.missing[0];
        session.intent_data.awaiting_field = next.field;
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform, intent_data: session.intent_data,
          status: 'AWAITING_FIELD',
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `✅ Got it.\n\n📝 ${next.ask}` });
      }

      // All compulsory fields collected — move to PIN confirmation, with the conversion shown.
      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'AWAITING_PIN',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      const rate2 = await getExchangeRate();
      const tok2 = session.intent_data.selected_token || 'USD₮';

      return NextResponse.json({
        action: 'REPLY',
        message: [
          `✅ *Confirm your payment*`,
          ``,
          `*${session.intent_data.provider || ''} ${session.intent_data.intent}*`,
          session.intent_data.verified_name ? `👤 ${session.intent_data.verified_name}` : null,
          `📱 ${session.intent_data.destination_account}`,
          // ⚡ Currency conversion — the app always shows what you'll actually pay.
          `💰 ${formatConversion(Number(session.intent_data.amount_ngn), rate2, tok2)}`,
          ``,
          `🔐 Enter your PIN to confirm.`,
          // Telegram lets us delete the PIN message automatically. WhatsApp and X do NOT —
          // their APIs cannot delete a user's message. So on those platforms we must tell
          // the user to remove it themselves, or it stays in the chat forever.
          platform !== 'TELEGRAM' ? `\n_⚠️ Please delete your PIN message after sending — I can't remove it on ${platform}._` : null,
        ].filter(Boolean).join('\n'),
      });
    }
    // ⚡ STATE: PROVIDER SELECTION ⚡
    // The chat equivalent of the web form's provider dropdown. Previously the agent asked
    // "which disco?" but never LISTED them — so a user who didn't already know the exact
    // VTpass service id ("ibadan-electric") had no way forward.
    else if (session?.status === 'AWAITING_PROVIDER') {
      const spec = providersFor(session.intent_data.intent);
      if (!spec) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        return NextResponse.json({ action: 'REPLY', message: "Something went wrong — let's start again." });
      }

      const picked = matchProvider(text.trim(), spec.options);
      if (!picked) {
        return NextResponse.json({
          action: 'REPLY',
          message: `❌ I didn't recognise that.\n\n${spec.prompt}\n\n${renderOptions(spec.options)}\n\n_Reply with the number, or the name._`,
        });
      }

      session.intent_data.provider = picked.id;
      session.intent_data.provider_label = picked.label;

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'ROUTING',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      // Fall through: re-enter the main flow with the provider now known.
      // Resume from the stored intent (like AWAITING_DATA_PLAN / AWAITING_METER_TYPE):
      // reset local status to the details baseline, clear the menu reply so the master
      // sweep doesn't re-parse "1" as a fresh intent, and continue instead of returning.
      session.status = 'AWAITING_DETAILS';
      text = "";
      isContinuingToAI = true;
      prependSystemMsg = `✅ *${picked.label}*\n\n`;
    }
    // ⚡ STATE: CABLE RENEW vs CHANGE (DStv/GOtv) ⚡
    else if (session?.status === 'AWAITING_CABLE_ACTION') {
      const map: Record<string, string> = { '1': 'renew', '2': 'change' };
      const picked = map[userInput] || (/(renew|same|current)/i.test(text) ? 'renew' : /(change|different|new)/i.test(text) ? 'change' : null);

      if (!picked) {
        return NextResponse.json({ action: 'REPLY', message: "❌ Reply with *1* to renew your current package, or *2* to change it." });
      }

      session.intent_data.cable_action = picked;

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'ROUTING',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      // Resume from the stored intent and continue into the master sweep.
      session.status = 'AWAITING_DETAILS';
      text = "";
      isContinuingToAI = true;
      prependSystemMsg = picked === 'renew'
        ? `✅ *Renewing your current package*\n\n`
        : `✅ *Changing package*\n\n`;
    }
    // ⚡ STATE: DATA PLAN CATEGORY (Daily / Weekly / Monthly / SME / Broadband…) ⚡
    // The chat equivalent of the web app's data category tabs. Without this, a user picking
    // MTN data would get ~50 plans dumped as one wall of text.
    else if (session?.status === 'AWAITING_PLAN_CATEGORY') {
      const serviceID = variationServiceId(session.intent_data.intent, session.intent_data.provider);
      const options = await fetchVariations(serviceID);
      const groups = groupDataPlans(options);

      const picked = matchCategory(text.trim(), groups);
      if (!picked) {
        return NextResponse.json({
          action: 'REPLY',
          message: `❌ I didn't recognise that.\n\n📦 *What kind of plan?*\n\n${renderCategoryMenu(groups)}\n\n_Reply with the number._`,
        });
      }

      session.intent_data.plan_category = picked.category;

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'AWAITING_VARIATION',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      return NextResponse.json({
        action: 'REPLY',
        message: `📦 *${picked.category} plans:*\n\n${renderOptions(picked.plans, { showPrice: true })}\n\n_Reply with the number._`,
      });
    }
    // ⚡ STATE: VARIATION SELECTION (data plans, cable packages, exam products) ⚡
    else if (session?.status === 'AWAITING_VARIATION') {
      const serviceID = variationServiceId(session.intent_data.intent, session.intent_data.provider);
      const allOptions = await fetchVariations(serviceID);

      // If they picked a category, match within it — so "2" means the 2nd Daily plan,
      // not the 2nd plan overall.
      let options = allOptions;
      if (session.intent_data.plan_category) {
        const group = groupDataPlans(allOptions).find(g => g.category === session.intent_data.plan_category);
        if (group) options = group.plans;
      }

      const picked = matchVariation(text.trim(), options);
      if (!picked) {
        return NextResponse.json({
          action: 'REPLY',
          message: `❌ I didn't recognise that.\n\n📦 *Choose a plan:*\n\n${renderOptions(options, { showPrice: true })}\n\n_Reply with the number._`,
        });
      }

      session.intent_data.variation_code = picked.id;
      session.intent_data.variation_label = picked.label;
      // The plan price IS the amount for these services.
      if (picked.price) session.intent_data.amount_ngn = picked.price;

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'ROUTING',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      // Resume from the stored intent and continue into the master sweep.
      session.status = 'AWAITING_DETAILS';
      text = "";
      isContinuingToAI = true;
      prependSystemMsg = `✅ *${picked.label}* — ₦${Number(picked.price || 0).toLocaleString()}\n\n`;
    }
    // STATE: CHAIN SELECTION ⚡
    // Chain was previously hardcoded to CELO, so a user could never pay on Base from chat.
    else if (session?.status === 'AWAITING_CHAIN') {
      const chainMap: Record<string, 'CELO' | 'BASE'> = { '1': 'CELO', '2': 'BASE' };
      const picked = chainMap[userInput];

      if (!picked) {
        return NextResponse.json({ action: 'REPLY', message: "❌ Reply with *1* for Celo or *2* for Base." });
      }

      session.intent_data.chain = picked;

      // Only offer tokens that actually EXIST on the chosen chain.
      const available = tokensForChain(picked);
      const list = available.map((t, i) => `*${i + 1}.* ${t}`).join('\n');

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'AWAITING_TOKEN',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      return NextResponse.json({
        action: 'REPLY',
        message: `⛓️ *${picked}* selected.\n\n💰 *Which token?*\n\n${list}`,
      });
    }
    // STATE: TOKEN SELECTION
    else if (session?.status === 'AWAITING_TOKEN') {
      // 🔴 THE OLD MAP WAS BROKEN: it offered 'USDT', 'cUSD' and a fake 'Fiat' option —
      // but the REAL symbols are 'USD₮' and 'USDm'. Every agent payment using those
      // would fail token resolution at the relayer. Now we build the list from the actual
      // supported tokens, filtered to the chain the user picked.
      const chosenChain = (session.intent_data.chain || 'CELO').toUpperCase() as 'CELO' | 'BASE';
      const available = tokensForChain(chosenChain);

      const idx = parseInt(userInput, 10) - 1;
      const selected = available[idx];

      if (!selected) {
        const list = available.map((t, i) => `*${i + 1}.* ${t}`).join('\n');
        return NextResponse.json({ action: 'REPLY', message: `❌ Invalid choice. On ${chosenChain}:\n\n${list}` });
      }

      session.intent_data.selected_token = selected;
      session.intent_data.pin_attempts = 0; 

      // ⚡ PARITY GATE — enforce every compulsory field the WEB FORM requires.
      //
      // The app will not let a user pay for electricity without a phone number (the token
      // is delivered by SMS), or make an international payment without a valid email. The
      // agent must enforce the SAME rules — otherwise it submits a payment the app itself
      // would have rejected, and it fails at vend time (or vends and the user never
      // receives their token).
      const isIntl = !!(session.intent_data.country && session.intent_data.country !== 'NG');
      const parity = checkParity(session.intent_data.intent, session.intent_data, { isInternational: isIntl });

      if (parity.error) {
        return NextResponse.json({ action: 'REPLY', message: `⚠️ ${parity.error}` });
      }

      if (parity.missing.length > 0) {
        // Ask for the first missing compulsory field, then resume.
        const next = parity.missing[0];
        session.intent_data.awaiting_field = next.field;
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform, intent_data: session.intent_data,
          status: 'AWAITING_FIELD',
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        return NextResponse.json({ action: 'REPLY', message: `📝 ${next.ask}` });
      }

      // ⚡ DUPLICATE ELECTRICITY GUARD — the app blocks an identical meter payment on the
      // same day, because double-vending a token is a common and expensive user error.
      if (session.intent_data.intent === 'ELECTRICITY') {
        const dup = await isDuplicateElectricity(
          supabase,
          globalUser?.wallet_address || '',
          session.intent_data.destination_account,
          Number(session.intent_data.amount_ngn)
        );
        if (dup) {
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
          return NextResponse.json({
            action: 'REPLY',
            message: `⚠️ *Looks like a duplicate.*\n\nYou already paid ₦${Number(session.intent_data.amount_ngn).toLocaleString()} to meter ${session.intent_data.destination_account} today.\n\nIf you really meant to pay again, please do it in the app so you can confirm it deliberately.`,
          });
        }
      }

      await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: session.intent_data, status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

      let detailsRow = "";
      if (session.intent_data.intent === 'VEND_DATA') detailsRow = `Plan: ${session.intent_data.variation_name}\nNetwork: ${session.intent_data.provider?.toUpperCase()}`;
      else if (session.intent_data.intent === 'VEND_AIRTIME') detailsRow = `Network: ${session.intent_data.provider?.toUpperCase()}`;
      else if (session.intent_data.intent === 'BANK_TRANSFER') detailsRow = `Bank: ${session.intent_data.provider?.toUpperCase()}`;
      else detailsRow = `Name: ${session.intent_data.verified_name || 'N/A'}`;

      const total = Number(session.intent_data.amount_ngn || 0) + Number(session.intent_data.fee || 0);
      return NextResponse.json({
          action: 'REPLY',
          message: `🤖 **Final Checkout**\n\nService: ${session.intent_data.intent.replace('_', ' ')}\nAccount: ${session.intent_data.destination_account}\n${detailsRow}\nAmount: ${currencySymbol}${session.intent_data.amount_ngn || 0}\nPayment: **${selected}**\n**Total: ${currencySymbol}${total}**\n\n🔒 Reply with your **PIN** to confirm.`
      });
    }
    // STATE: DATA PLAN
    else if (session?.status === 'AWAITING_DATA_PLAN') {
        const selection = text.trim();
        const variation = session.intent_data.available_variations.find((v: any) => v.id === selection);
        if (!variation) return NextResponse.json({ action: 'REPLY', message: "❌ Invalid selection. Please reply with a valid number from the list." });
        
        session.intent_data.variation_code = variation.code;
        session.intent_data.variation_name = variation.name;
        session.intent_data.amount_ngn = variation.price; 
        session.status = 'AWAITING_DETAILS'; 
        text = ""; 
        isContinuingToAI = true;
    }
    // STATE: METER TYPE
    else if (session?.status === 'AWAITING_METER_TYPE') {
        const typeMap: Record<string, string> = { '1': 'prepaid', '2': 'postpaid' };
        const selectedType = typeMap[userInput];

        if (!selectedType) return NextResponse.json({ action: 'REPLY', message: "❌ Please reply with **1** for Prepaid or **2** for Postpaid." });
        
        const verification = await verifyAccount(
            session.intent_data.intent,
            session.intent_data.destination_account,
            selectedType,
            session.intent_data.provider
        );
        if (!verification.success) {
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
            return NextResponse.json({ action: 'REPLY', message: `❌ ${verification.message || 'Verification failed. Please check the meter number and try again.'}` });
        }

        session.intent_data.meter_type = selectedType;
        session.intent_data.verified_name = verification.customer_name;
        session.intent_data.customer_name = verification.customer_name;
        session.intent_data.customer_address = verification.customer_address;
        session.intent_data.verified_min = verification.min_amount;
        session.status = 'AWAITING_DETAILS'; 
        
        prependSystemMsg = `✅ **Meter Verified!**\nName: ${verification.customer_name}\n${verification.customer_address ? `Address: ${verification.customer_address}\n` : ''}\n`;
        text = ""; 
        isContinuingToAI = true;
    }
    else if (session?.status === 'AWAITING_DETAILS') {
       isContinuingToAI = true;
    } else {
       isContinuingToAI = true;
    }

    if (!isContinuingToAI) return NextResponse.json({ success: true });

    let intentData: any = {};

    // Determine baseline Intent first — freshIntentCheck (a crude keyword match) is only
    // ever a SEED/fallback value here, never a gate on whether the AI runs. It previously
    // skipped the Claude call entirely whenever it matched a literal substring like
    // "airtime" or "data" — meaning most clearly-worded messages never actually reached
    // the AI at all, and got only the regex sweep's (extractEntities) far cruder
    // extraction. Claude now always gets a chance to parse the real message; the keyword
    // match and regex sweep remain purely as backstops if the AI call fails or misses a
    // field.
    if (session?.status === 'AWAITING_DETAILS') {
        intentData = session.intent_data;
    } else {
        intentData = { intent: freshIntentCheck, amount_ngn: null, destination_account: null, provider: null, phone: null, email: null };
    }

    // ⚡ 4. THE MASTER SWEEP ⚡
    let aiParsed: any = null;
    if (text !== "") {
        try {
            aiParsed = await parseIntent(text);

            // Map the engine's intent names onto the core's SERVICE_RULES keys.
            const intentMap: Record<string, string> = {
                VEND_AIRTIME: 'VEND_AIRTIME',
                VEND_DATA: 'VEND_DATA',
                PAY_ELECTRICITY: 'ELECTRICITY',
                PAY_CABLE: 'TV',
                TRANSACTION_HISTORY: 'TRANSACTION_HISTORY',
                CHECK_BALANCE: 'CHECK_BALANCE',
                LIST_SCHEDULES: 'LIST_SCHEDULES',
                CANCEL_SCHEDULE: 'CANCEL_SCHEDULE',
                BANK_TRANSFER: 'BANK_TRANSFER',
                EDUCATION: 'EDUCATION',
                INTERNATIONAL: 'INTERNATIONAL',
                HELP: 'HELP',
            };

            const mapped = intentMap[aiParsed.intent];

            intentData = {
                ...intentData,
                ...(mapped ? { intent: mapped } : {}),
                ...(aiParsed.amount_ngn ? { amount_ngn: aiParsed.amount_ngn } : {}),
                ...(aiParsed.destination_account ? { destination_account: aiParsed.destination_account } : {}),
                ...(aiParsed.provider ? { provider: aiParsed.provider } : {}),
                ...(aiParsed.meter_type ? { meter_type: aiParsed.meter_type } : {}),
            };
        } catch (e) {
            // Ignore AI errors — the regex sweep below still catches the common cases.
        }

        // ⚡ GUARANTEED REGEX OVERRIDE: fills in anything the AI didn't already resolve
        // (extractEntities only ever sets a field when it's still falsy — never overwrites
        // an AI-sourced value).
        intentData = extractEntities(text, intentData);
    }

    if (intentData?.intent === 'TRANSACTION_STATUS' || intentData?.intent === 'STATUS') intentData.intent = 'TRANSACTION_HISTORY';

    // ⚡ 4b. CAPABILITY & FEASIBILITY ⚡
    //
    // The agent should never shrug. For EVERY request we ask: can we actually do this,
    // right now? If not, we say why — and what the user should do instead.
    if (aiParsed) {
        // Help / capability menu
        if (aiParsed.intent === 'HELP') {
            return NextResponse.json({ action: 'REPLY', message: await describeCapabilities() });
        }

        // Things that are genuinely possible, but belong in the app (bank, education,
        // international). Previously these fell into "I didn't catch that" — which made a
        // supported feature look broken.
        // Bank transfer and Education stay app-only (see capabilities.ts for why).
        // INTERNATIONAL is fully supported in chat — validated against VTpass's live country list.
        const appOnly = ['BANK_TRANSFER', 'EDUCATION'];
        const isForeign = aiParsed.country && aiParsed.country !== 'NG';
        const effectiveIntent = isForeign ? 'INTERNATIONAL' : aiParsed.intent;

        if (appOnly.includes(effectiveIntent)) {
            const f = await assessFeasibility({ intent: effectiveIntent });
            const spec = getCapability(capabilityForIntent(effectiveIntent)!);
            return NextResponse.json({
                action: 'REPLY',
                message: [
                    `📱 *${spec?.label || 'That'}* — I can't complete this from chat, but here's how:`,
                    ``,
                    f.reason,
                    ``,
                    ...f.suggestions.map(sug => `• ${sug}`),
                ].join('\n'),
            });
        }

        // INTERNATIONAL — guided, validated against the live VTpass country catalogue.
        if (effectiveIntent === 'INTERNATIONAL') {
            const f = await assessFeasibility({
                intent: 'INTERNATIONAL',
                country: aiParsed.country,
                account: aiParsed.destination_account,
                amountNgn: aiParsed.amount_ngn,
            });

            if (!f.possible) {
                return NextResponse.json({ action: 'REPLY', message: [`⚠️ ${f.reason}`, ``, ...f.suggestions.map(s2 => `• ${s2}`)].join('\n') });
            }
            if (f.missing.length) {
                return NextResponse.json({ action: 'REPLY', message: [`🌍 ${f.reason}`, ...(f.suggestions.length ? ['', ...f.suggestions.map(s2 => `• ${s2}`)] : [])].join('\n') });
            }

            // Everything present — hand off to the app, which owns the operator/product
            // selection UI. (Chat collects and validates; the app completes the vend.)
            const link = `${process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com'}`;
            return NextResponse.json({
                action: 'REPLY',
                message: [
                    `🌍 *International airtime*`,
                    ``,
                    `Country: ${aiParsed.country}`,
                    `📱 ${aiParsed.destination_account}`,
                    `💰 ₦${Number(aiParsed.amount_ngn).toLocaleString()}`,
                    ``,
                    `Open AbaPay to pick the operator and confirm: ${link}`,
                ].join('\n'),
            });
        }

        // Supported-in-chat requests: check they're actually doable before we proceed.
        if (['VEND_AIRTIME', 'VEND_DATA', 'ELECTRICITY', 'TV'].includes(intentData.intent)) {
            const f = await assessFeasibility({
                intent: intentData.intent,
                provider: intentData.provider,
                amountNgn: intentData.amount_ngn,
                account: intentData.destination_account,
                meterType: intentData.meter_type,
                verifiedMin: intentData.verified_min,
            });

            // Blocked (kill switch, below minimum, above cap) — explain and suggest.
            if (!f.possible) {
                await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
                return NextResponse.json({
                    action: 'REPLY',
                    message: [`⚠️ ${f.reason}`, ``, ...f.suggestions.map(sug => `• ${sug}`)].join('\n'),
                });
            }
            // If details are missing, the existing state machine below collects them.
        }
    }

    // ⚡ 4c. AUTOMATIONS — create / list / cancel schedules conversationally ⚡
    if (aiParsed) {
        // "show my schedules"
        if (aiParsed.intent === 'LIST_SCHEDULES') {
            const { data: scheds } = await supabase
                .from('scheduled_bills')
                .select('*')
                .ilike('wallet_address', globalUser?.wallet_address || '')
                .eq('is_active', true);

            if (!scheds || scheds.length === 0) {
                return NextResponse.json({ action: 'REPLY', message: "📭 You have no automations yet.\n\n_Try: \"Every Tuesday buy ₦200 airtime for 08012345678\"_" });
            }

            const lines = (scheds as any[]).map((sc) => {
                const when = sc.frequency === 'weekly'
                    ? `every ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][sc.day_of_week] || '?'}`
                    : sc.frequency === 'daily' ? 'daily' : `on the ${sc.day_of_month}${sc.day_of_month === 1 ? 'st' : sc.day_of_month === 2 ? 'nd' : sc.day_of_month === 3 ? 'rd' : 'th'} monthly`;
                return `• *${sc.provider || ''} ${sc.service_category}* — ₦${Number(sc.amount_ngn).toLocaleString()} ${when}\n  ${sc.billers_code} · ${sc.auto_execute ? '🤖 auto-pays' : '🔔 reminds you'}`;
            });

            return NextResponse.json({ action: 'REPLY', message: `🔁 *Your automations:*\n\n${lines.join('\n\n')}\n\n_Say "cancel my airtime schedule" to remove one._` });
        }

        // "cancel my schedule"
        if (aiParsed.intent === 'CANCEL_SCHEDULE') {
            const { data: scheds } = await supabase
                .from('scheduled_bills')
                .select('id, provider, service_category')
                .ilike('wallet_address', globalUser?.wallet_address || '')
                .eq('is_active', true);

            if (!scheds || scheds.length === 0) {
                return NextResponse.json({ action: 'REPLY', message: "You have no active automations to cancel." });
            }

            // If they named a service, cancel that one; otherwise cancel all (they asked to stop).
            const target = (scheds as any[]).filter((sc) =>
                !aiParsed.provider || String(sc.provider || '').toUpperCase() === String(aiParsed.provider).toUpperCase()
            );

            await supabase.from('scheduled_bills').update({ is_active: false }).in('id', target.map((t: any) => t.id));
            return NextResponse.json({ action: 'REPLY', message: `✅ Cancelled ${target.length} automation${target.length === 1 ? '' : 's'}.` });
        }

        // "every Tuesday buy 200 airtime for 08012345678"
        if (aiParsed.is_recurring && ['VEND_AIRTIME', 'VEND_DATA', 'ELECTRICITY', 'TV'].includes(intentData.intent)) {
            const f = await assessFeasibility({
                intent: intentData.intent,
                provider: intentData.provider,
                amountNgn: intentData.amount_ngn,
                account: intentData.destination_account,
                meterType: intentData.meter_type,
            });

            if (!f.possible) {
                return NextResponse.json({ action: 'REPLY', message: [`⚠️ ${f.reason}`, ``, ...f.suggestions.map(s2 => `• ${s2}`)].join('\n') });
            }
            if (f.missing.length) {
                return NextResponse.json({ action: 'REPLY', message: [`🔁 Happy to set that up — ${f.reason}`, ``, ...f.suggestions.map(s2 => `• ${s2}`)].join('\n') });
            }

            const serviceID = resolveServiceId(intentData.intent, intentData.provider) || intentData.provider;
            const category = intentData.intent === 'ELECTRICITY' ? 'ELECTRICITY'
                           : intentData.intent === 'TV' ? 'CABLE'
                           : intentData.intent === 'VEND_DATA' ? 'DATA' : 'AIRTIME';

            // Will this actually auto-pay? Only if they've granted an on-chain allowance.
            const tokenSym = 'USD₮';
            const allowance = await getRemainingAllowance(globalUser?.wallet_address || '', tokenSym, 'CELO');
            const canAutoPay = allowance.ok && allowance.remaining > 0;

            const { error: schedErr } = await supabase.from('scheduled_bills').insert({
                wallet_address: (globalUser?.wallet_address || '').toLowerCase(),
                service_id: serviceID,
                service_category: category,
                provider: intentData.provider,
                billers_code: intentData.destination_account,
                amount_ngn: Number(intentData.amount_ngn),
                meter_type: intentData.meter_type || null,
                blockchain: 'CELO',
                token_used: tokenSym,
                frequency: aiParsed.frequency || 'monthly',
                day_of_week: aiParsed.day_of_week,
                day_of_month: aiParsed.day_of_month,
                auto_execute: canAutoPay,
                notify_telegram: platform === 'TELEGRAM' ? platform_id : null,
                is_active: true,
            });

            if (schedErr) {
                console.error('[DeAI] schedule create failed:', schedErr.message);
                return NextResponse.json({ action: 'REPLY', message: "⚠️ Couldn't save that automation. Please try again." });
            }

            const when = aiParsed.frequency === 'weekly'
                ? `every ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][aiParsed.day_of_week ?? 0]}`
                : aiParsed.frequency === 'daily' ? 'every day'
                : `on the ${aiParsed.day_of_month}th of each month`;

            return NextResponse.json({
                action: 'REPLY',
                message: [
                    `🔁 *Automation set!*`,
                    ``,
                    `*${intentData.provider} ${category}* — ₦${Number(intentData.amount_ngn).toLocaleString()}`,
                    `📱 ${intentData.destination_account}`,
                    `📅 ${when}`,
                    ``,
                    canAutoPay
                        ? `🤖 I'll *pay this automatically* from your approved limit (${allowance.remaining.toFixed(2)} ${tokenSym} left). No action needed from you.`
                        : `🔔 I'll *remind you* each time with a one-tap link.\n\n_Want me to pay it automatically? Approve a spend limit in the AbaPay app and I'll take it from there._`,
                ].join('\n'),
            });
        }
    }

    // 🔒 EMERGENCY REVOKE — usable from any channel, before anything else.
    //
    // A user who suspects their chat is compromised needs to stop the bleeding NOW, not go
    // hunting for the app. This disables the link instantly so the agent can no longer spend.
    //
    // NOTE: this is the OPERATIONAL kill. The definitive one is on-chain
    // (setSpendingAllowance(token, 0)) — we tell them to do that too, because it's the only
    // thing that holds if our backend itself is compromised.
    {
      const t0 = text.trim().toLowerCase();
      if (/^(revoke|stop|disable|lock|panic|freeze)\b/.test(t0)) {
        if (identity?._linkId) {
          await supabase.from('agent_links').update({ is_active: false }).eq('id', identity._linkId);
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

          try {
            await sendTelegramAlert(`🚨 *USER REVOKED AGENT ACCESS*\n📲 ${channel}\n👤 \`${String(globalUser?.wallet_address || '').slice(0, 10)}...\`\n\n_User may suspect compromise._`);
          } catch { /* best-effort */ }

          return NextResponse.json({
            action: 'REPLY',
            message:
              `🔒 *Agent access disabled.*\n\nI can no longer make payments from this chat.\n\n` +
              `⚠️ *For full protection, also revoke on-chain:*\n` +
              `Open AbaPay → Agent → set your spend limit to *0*.\n\n` +
              `_That's the only step that holds even if our servers were compromised — it's enforced by the blockchain, not by us._`,
          });
        }
      }
    }

    // ⚡ 4d. SUPPORT — available from every channel ⚡
    //
    // A user who paid via Telegram and hit a problem must be able to get help RIGHT THERE.
    // Telling them to go to a website is how you lose them. The operator replies from the
    // admin dashboard and the answer lands back in this same chat.
    {
      const t = text.trim().toLowerCase();
      const wantsSupport = /^(support|help me|contact|complain|agent|human|talk to (a )?(human|person|support))\b/.test(t);

      if (session?.status === 'AWAITING_SUPPORT_MESSAGE') {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

        // Attach their most recent problem transaction, so the operator has context
        // without having to ask for it.
        const { data: recentFail } = await supabase
          .from('transactions')
          .select('tx_hash')
          .ilike('wallet_address', globalUser?.wallet_address || '')
          .in('status', ['FAILED_VENDING', 'PENDING', 'PROCESSING'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const { error: ticketErr } = await supabase.from('support_tickets').insert({
          wallet_address: (globalUser?.wallet_address || '').toLowerCase(),
          channel,
          channel_user_id: platform_id,
          message: text.trim(),
          tx_hash: (recentFail as any)?.tx_hash || null,
          status: 'OPEN',
        });

        if (ticketErr) {
          console.error('[Support] ticket create failed:', ticketErr.message);
          return NextResponse.json({ action: 'REPLY', message: "⚠️ Couldn't send that to support. Please try again." });
        }

        try {
          await sendTelegramAlert(
            `🎫 *NEW SUPPORT TICKET*\n` +
            `📲 *Channel:* ${channel}\n` +
            `👤 *Wallet:* \`${(globalUser?.wallet_address || 'unknown').slice(0, 10)}...\`\n` +
            `${(recentFail as any)?.tx_hash ? `🔗 *Tx:* \`${(recentFail as any).tx_hash}\`\n` : ''}` +
            `💬 _${text.trim().slice(0, 300)}_\n\n` +
            `_Reply in Admin → Support._`
          );
        } catch { /* alerting must never block the ticket */ }

        return NextResponse.json({
          action: 'REPLY',
          message: "🎫 *Thanks — I've sent that to our support team.*\n\nThey'll reply right here in this chat, usually within a few hours.",
        });
      }

      if (wantsSupport) {
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform,
          intent_data: {},
          status: 'AWAITING_SUPPORT_MESSAGE',
          expires_at: new Date(Date.now() + 600000).toISOString(),
        }, { onConflict: 'chat_id' });

        return NextResponse.json({
          action: 'REPLY',
          message: "🎫 *Support*\n\nTell me what's wrong and I'll pass it straight to our team — they'll reply right here.\n\n_If it's about a specific payment, mention it and I'll attach the details automatically._",
        });
      }
    }

    if (!SERVICE_RULES[intentData.intent] && intentData.intent !== 'TRANSACTION_HISTORY' && intentData.intent !== 'CHECK_BALANCE') intentData.intent = 'UNKNOWN';

    if (intentData.intent === 'UNKNOWN') {
        // Never a bare shrug — always show what IS possible. The model may still have
        // extracted partial signals (a number, an amount, a provider) even though it
        // couldn't confidently settle on a full intent — use those to tailor the
        // suggestion instead of always showing the identical static menu regardless of
        // what the user actually typed.
        const hints: string[] = [];
        if (intentData.destination_account) hints.push(`a number/account (\`${intentData.destination_account}\`)`);
        if (intentData.amount_ngn) hints.push(`an amount (₦${Number(intentData.amount_ngn).toLocaleString()})`);
        if (intentData.provider) hints.push(`a provider (${intentData.provider})`);

        const contextLine = hints.length
            ? `I noticed ${hints.join(' and ')} in there, but wasn't sure what to do with it — try being a bit more specific, e.g. "buy 500 airtime for 08012345678" or "pay 2000 electricity for meter 04123456789".\n\n`
            : '';

        return NextResponse.json({ action: 'REPLY', message: `🤔 I didn't quite catch that.\n\n${contextLine}${await describeCapabilities()}` });
    }

    // ⚡ CHECK_BALANCE — this was previously forced to UNKNOWN (no SERVICE_RULES entry,
    // since it isn't a payable service), even though describeCapabilities() itself tells
    // users to say "balance". crypto/fiatBalance/currentCountry/currencySymbol are already
    // computed above for the welcome banner — reuse them instead of re-fetching.
    if (intentData.intent === 'CHECK_BALANCE') {
        return NextResponse.json({
            action: 'REPLY',
            message: `💰 **Your Balance**\n\n🌍 Region: ${currentCountry}\n💵 Fiat: ${currencySymbol}${fiatBalance}\n🪙 Crypto:\n${formatChainBalances(crypto)}`,
        });
    }

    if (intentData.intent === 'TRANSACTION_HISTORY') {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

        // ⚡ FULL PARITY WITH THE WEB RECEIPT.
        // This previously showed only category/amount/status — so a user could NOT retrieve
        // their electricity token or exam PIN from chat, which is the single most important
        // thing they need after paying. Now we surface everything the web receipt does.
        const { data: recentTxs } = await supabase
            .from('transactions')
            .select('service_category, network, amount_naira, display_amount, status, created_at, token_used, purchased_code, units, tx_hash, account_number, country_code, blockchain')
            .ilike('wallet_address', globalUser.wallet_address)
            .order('created_at', { ascending: false })
            .limit(5);

        if (!recentTxs || recentTxs.length === 0) {
            return NextResponse.json({ action: 'REPLY', message: "📜 You don't have any transactions yet.\n\n_Try: \"Send ₦500 airtime to 08012345678\"_" });
        }

        const statusIcon = (s: string) => {
            const st = String(s || '').toUpperCase();
            if (st === 'SUCCESS') return '✅';
            if (st === 'PENDING' || st === 'PROCESSING') return '⏳';
            if (st === 'REFUNDED') return '↩️';
            return '❌';
        };

        const lines = (recentTxs as any[]).map((tx, i) => {
            const dateStr = new Date(tx.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

            // International transactions store a pre-formatted local-currency amount.
            const amount = (tx.country_code && tx.display_amount)
                ? tx.display_amount
                : `₦${Number(tx.amount_naira).toLocaleString()}`;

            const parts = [
                `${statusIcon(tx.status)} *${(tx.network || '').toUpperCase()} ${(tx.service_category || 'PAYMENT').replace('_', ' ')}*`,
                `${amount} · ${tx.token_used || 'USD₮'}`,
                tx.account_number ? `📱 ${tx.account_number}` : null,
                `${tx.status} · ${dateStr}`,
            ];

            // ⚡ THE TOKEN / PIN — what people actually come back for.
            if (tx.purchased_code && tx.purchased_code !== 'Vended Successfully') {
                parts.push(`🔑 *Token:* \`${tx.purchased_code}\``);
            }
            if (tx.units) parts.push(`⚡ Units: ${tx.units}`);

            // Pending transactions: tell them what's happening, don't leave them guessing.
            if (['PENDING', 'PROCESSING'].includes(String(tx.status).toUpperCase())) {
                parts.push(`_Still confirming — I'll update you shortly._`);
            }

            return `${i + 1}. ` + parts.filter(Boolean).join('\n   ');
        });

        return NextResponse.json({
            action: 'REPLY',
            message: `📜 *Your recent transactions:*\n\n${lines.join('\n\n')}\n\n_Say "history" any time. Tokens stay here for when you need them._`,
        });
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
            
            // ⚡ THE "GHOST MESSAGE" FIX: Dynamic Echo
            let savedItems = [];
            if (intentData.amount_ngn) savedItems.push(`₦${intentData.amount_ngn}`);
            if (intentData.destination_account) savedItems.push(`${intentData.destination_account}`);
            if (intentData.email) savedItems.push(`Email Saved`);
            
            let echoMsg = savedItems.length > 0 ? `💡 *Got it! (${savedItems.join(" | ")})*\n\n` : "";

            return NextResponse.json({ action: 'REPLY', message: `${prependSystemMsg}${echoMsg}To complete your ${intentData.intent.replace('_', ' ')}, please reply with ${missing.join(", ")}.` });
        }

        const activeMin = intentData.verified_min || rules.min;
        if (activeMin && intentData.amount_ngn && intentData.amount_ngn < activeMin) {
            intentData.amount_ngn = null; 
            await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
            return NextResponse.json({ action: 'REPLY', message: `❌ Minimum amount for this service is ${currencySymbol}${activeMin}. Please reply with a valid amount.` });
        }
    }

    // DATA VARIATIONS GATE 
    if (intentData.intent === 'VEND_DATA' && !intentData.variation_code) {
        const variations = await fetchDataVariations(intentData.provider);
        intentData.available_variations = variations;
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DATA_PLAN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        
        let msg = `📊 **Select Data Plan for ${intentData.provider.toUpperCase()}**\n\n`;
        variations.forEach((v: any) => msg += `${v.id}️⃣ ${v.name} - ${currencySymbol}${v.price}\n`);
        msg += `\n*Reply with the number (e.g., 1).*`;
        
        return NextResponse.json({ action: 'REPLY', message: msg });
    }

    intentData.fee = ['ELECTRICITY', 'TV', 'EDUCATION'].includes(intentData.intent) ? 100 : 0;

    // ⚡ PROVIDER GATE — list the options, don't make them guess ⚡
    //
    // The frontend gives users a dropdown. The agent must too. Without this, a user saying
    // "pay 2000 electricity, meter 021324..." would be asked "which disco?" and have no idea
    // that the answer needs to be a VTpass service id.
    if (!intentData.provider && providersFor(intentData.intent)) {
        const spec = providersFor(intentData.intent)!;

        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData,
            status: 'AWAITING_PROVIDER',
            expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}${spec.prompt}\n\n${renderOptions(spec.options)}\n\n_Reply with the number, or the name._`,
        });
    }

    // ⚡ VARIATION GATE — data plans, cable packages, exam products ⚡
    // These were never listed at all, so those flows could not complete in chat.
    // ⚡ CABLE: RENEW vs CHANGE (DStv/GOtv) ⚡
    // The frontend lets DStv/GOtv users RENEW their current package (no plan needed) or
    // CHANGE to a new one (plan required). The agent ignored this entirely — so it always
    // demanded a plan, making renewals impossible.
    if (intentData.intent === 'TV' && supportsRenew(intentData.provider) && !intentData.cable_action) {
        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData,
            status: 'AWAITING_CABLE_ACTION',
            expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}📺 *${(intentData.provider_label || intentData.provider).toUpperCase()}*\n\nWhat would you like to do?\n\n*1.* Renew my current package\n*2.* Change to a different package`,
        });
    }

    if (requiresVariation(intentData.intent, intentData.provider, intentData.cable_action) && !intentData.variation_code) {
        const serviceID = variationServiceId(intentData.intent, intentData.provider);
        const options = await fetchVariations(serviceID);

        if (options.length === 0) {
            return NextResponse.json({
                action: 'REPLY',
                message: `⚠️ I couldn't load the plans for ${intentData.provider_label || intentData.provider} right now. Please try again shortly, or pay in the app.`,
            });
        }

        // ⚡ DATA: GROUP BY CATEGORY (frontend parity).
        //
        // MTN alone returns ~50 plans. A flat numbered list is a wall of text in a chat
        // window. The web app groups them into tabs (Daily, Weekly, Monthly, SME,
        // Broadband…) — the agent uses the SAME categorizeDataPlan() function, so the two
        // can never group differently.
        //
        // Cable/education have few options, so a flat list is fine there.
        if (intentData.intent === 'VEND_DATA' || intentData.intent === 'INTERNET') {
            const groups = groupDataPlans(options);

            if (!intentData.plan_category) {
                await supabase.from('deai_sessions').upsert({
                    chat_id: platform_id, platform, intent_data: intentData,
                    status: 'AWAITING_PLAN_CATEGORY',
                    expires_at: new Date(Date.now() + 300000).toISOString(),
                }, { onConflict: 'chat_id' });

                return NextResponse.json({
                    action: 'REPLY',
                    message: `${prependSystemMsg}📦 *${(intentData.provider_label || intentData.provider).toUpperCase()} data — what kind of plan?*\n\n${renderCategoryMenu(groups)}\n\n_Reply with the number._`,
                });
            }

            // Category already chosen — list the plans inside it.
            const group = groups.find(g => g.category === intentData.plan_category);
            const plans = group?.plans || options;

            await supabase.from('deai_sessions').upsert({
                chat_id: platform_id, platform, intent_data: intentData,
                status: 'AWAITING_VARIATION',
                expires_at: new Date(Date.now() + 300000).toISOString(),
            }, { onConflict: 'chat_id' });

            return NextResponse.json({
                action: 'REPLY',
                message: `${prependSystemMsg}📦 *${intentData.plan_category} plans:*\n\n${renderOptions(plans, { showPrice: true })}\n\n_Reply with the number._`,
            });
        }

        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData,
            status: 'AWAITING_VARIATION',
            expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        const title = intentData.intent === 'TV' ? '📺 *Choose a package:*'
                    : intentData.intent === 'EDUCATION' ? '🎓 *Choose a product:*'
                    : '📦 *Choose a plan:*';

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}${title}\n\n${renderOptions(options, { showPrice: true })}\n\n_Reply with the number._`,
        });
    }

    // ⚡ ACCOUNT FORMAT — per service, per provider (frontend parity) ⚡
    //
    // The frontend enforces a DIFFERENT account format for nearly every service:
    //   airtime      -> exactly 11 digits, starts with 0
    //   electricity  -> >= 10
    //   bank         -> exactly 10
    //   spectranet   -> >= 5
    //   showmax      -> >= 11 (it's a phone number)
    //   cable        -> >= 10
    // The agent only ever checked Nigerian phone numbers, so a 6-digit "meter number" would
    // sail straight through to VTpass and fail there.
    if (intentData.destination_account && intentData.provider) {
        const acctCheck = checkAccountNumber(intentData.intent, intentData.destination_account, intentData.provider);
        if (!acctCheck.valid) {
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
            return NextResponse.json({ action: 'REPLY', message: `⚠️ ${acctCheck.error}` });
        }
    }

    // ⚡ AMOUNT LIMITS — skipped for fixed-price plans (frontend parity) ⚡
    //
    // When the user picked a data bundle or cable package, the PLAN PRICE IS THE PRICE — the
    // frontend skips min/max entirely. Without this the agent would reject a legitimate ₦50
    // data bundle for being "below the ₦100 minimum".
    if (intentData.amount_ngn) {
        const isFixedPlan = !!intentData.variation_code;
        const amtCheck = checkAmountParity(intentData.intent, Number(intentData.amount_ngn), {
            isFixedPlan,
            verifiedMin: intentData.verified_min,
        });
        if (!amtCheck.valid) {
            return NextResponse.json({ action: 'REPLY', message: `⚠️ ${amtCheck.error}` });
        }
    }

    // ⚡ UNIVERSAL ACCOUNT VERIFICATION (cable, JAMB) ⚡
    //
    // 🔴 The agent only ever verified ELECTRICITY meters. But the frontend refuses to submit
    // cable, bank or JAMB payments until VTpass returns a customer name — that's how the user
    // confirms they're paying the RIGHT smartcard/profile. Without it, a mistyped smartcard
    // number silently credits a stranger's DStv account, and the money is gone.
    //
    // (Electricity has its own gate below, because it also needs prepaid/postpaid first.)
    if (
        intentData.intent !== 'ELECTRICITY' &&
        requiresVerifiedName(intentData.intent, intentData.provider) &&
        intentData.destination_account &&
        !intentData.verified_name
    ) {
        const verification = await verifyAccount(
            intentData.intent,
            intentData.destination_account,
            undefined,
            intentData.provider
        );

        if (!verification.success) {
            await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
            return NextResponse.json({
                action: 'REPLY',
                message: `❌ ${verification.message || "I couldn't verify that account. Please check the number and try again."}`,
            });
        }

        intentData.verified_name = verification.customer_name;
        intentData.customer_name = verification.customer_name;
        if (verification.min_amount) intentData.verified_min = verification.min_amount;

        prependSystemMsg = `✅ *Verified*\n👤 ${verification.customer_name}\n\n`;
    }

    // ⚡ ELECTRICITY METER TYPE — asked only AFTER the disco is known.
    //
    // 🔴 This used to run BEFORE provider selection, so verifyAccount() had no serviceID to
    // verify against and meter verification could never succeed. Order matters here.
    if (intentData.intent === 'ELECTRICITY' && !intentData.meter_type) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_METER_TYPE', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}💡 *${intentData.provider_label || intentData.provider}* — meter \`${intentData.destination_account}\`\n\nIs this *Prepaid* or *Postpaid*?\n\n*1.* Prepaid\n*2.* Postpaid`,
        });
    }

    // ⚡ CHAIN SELECTION FIRST, THEN TOKEN ⚡
    //
    // 🔴 The old prompt was broken twice over:
    //   • it offered a "Fiat Balance" that doesn't exist as a payable token
    //   • it read crypto.usdt / crypto.usdc / crypto.cusd — keys that DON'T EXIST.
    //     The real balance keys are USD₮ / USDC / USDm, so every balance showed blank,
    //     and the resulting selection failed token resolution at the relayer.
    //
    // And chain was hardcoded to CELO, so Base was unreachable from chat.
    if (!intentData.chain) {
        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData,
            status: 'AWAITING_CHAIN',
            expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        const prefixMsg = intentData.provider && ['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent)
            ? `_(Network detected: *${String(intentData.provider).toUpperCase()}*)_\n\n` : "";

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}${prefixMsg}⛓️ *Which chain?*\n\n*1.* Celo\n*2.* Base\n\n_Reply with the number._`,
        });
    }

    // TOKEN SELECTION — only tokens that exist on the chosen chain, with REAL balances.
    if (!intentData.selected_token) {
        await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_TOKEN', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });

        const chosenChain = (intentData.chain || 'CELO').toUpperCase() as 'CELO' | 'BASE';
        const available = tokensForChain(chosenChain);
        const balances = await fetchCryptoBalances(globalUser?.wallet_address || "", chosenChain);

        const list = available
            .map((sym, i) => `*${i + 1}.* ${sym} — _${balances[sym] ?? '0.0000'}_`)
            .join('\n');

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}⛓️ *${chosenChain}*\n\n💰 *Which token?*\n\n${list}\n\n_Reply with the number._`,
        });
    }

  } catch (error) {
    console.error("System Error:", error);
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error. Please try again." });
  }
}
