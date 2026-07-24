// src/app/api/deai/core/route.ts
import { NextResponse } from 'next/server';
import { parseIntent } from '@/lib/deai/intentEngine';
import { humanizeReply } from '@/lib/deai/humanize';
import { verifyAccount as realVerifyAccount, fetchCryptoBalances as realFetchCryptoBalances, resolveServiceId } from '@/lib/deai/services';
import { createDeepLink } from '@/lib/deai/deeplink';
import { relayPayBillFor, getRemainingAllowance } from '@/lib/deai/relayer';
import { checkServiceAllowed, checkAgentSpendAllowed } from '@/lib/serviceRules';
import { assessFeasibility, describeCapabilities, getCapability, capabilityForIntent } from '@/lib/deai/capabilities';
import { checkParity, checkAccountNumber, checkAmount as checkAmountParity, isDuplicateElectricity, formatConversion, REQ, requiresVariation, supportsRenew, requiresVerifiedName } from '@/lib/parity';
import { sendTelegramAlert } from '@/lib/telegram';
import { checkPinAllowed, recordPinFailure, clearPinFailures, notifySpendOutOfBand } from '@/lib/deai/pinSecurity';
import { SUPPORTED_TOKENS } from '@/constants';
import { providersFor, renderOptions, matchProvider, needsVariation, variationServiceId, fetchVariations, matchVariation, groupDataPlans, renderCategoryMenu, matchCategory, renderOptionsPage, isNextPageRequest, matchPagedOption, type Option } from '@/lib/deai/selection';
import { createClient } from '@supabase/supabase-js';
import { verifyInternalRequest } from '@/utils/internalAuth';
import { verifyPin, isHashedPin, hashPin } from '@/utils/pinSecurity';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { checkAutonomousCapacity, groupByChainToken, executeAgentPayment, type BatchItem } from '@/lib/deai/batch';
import { ONBOARDING_STEPS, ONBOARDING_TRIGGER_RE, ONBOARDING_NEXT_RE, ONBOARDING_CANCEL_RE, renderOnboardingStep, isLastOnboardingStep } from '@/lib/deai/onboarding';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string
);

// ⚡ 1. THE ENTERPRISE VALIDATION ENGINE ⚡
const SERVICE_RULES: Record<string, any> = {
    VEND_AIRTIME: { min: 100, max: 50000, required: ['amount_ngn', 'destination_account', 'provider'] },
    VEND_DATA: { min: 50, max: 50000, required: ['destination_account', 'provider'] },
    ELECTRICITY: { min: 1000, max: 100000, required: ['amount_ngn', 'destination_account', 'phone', 'email'] },
    // 🔴 THE BUG THIS FIXES: 'amount_ngn' used to be required here, asked UP FRONT before the
    // user had even named a provider or picked a package — but cable is fixed-price: the
    // amount is ALWAYS either the chosen package's price, or the verified renewal amount (see
    // the CABLE FAST PATH below and buildCablePackageOptions). Asking for it first meant the
    // user typed an arbitrary number that got silently discarded the moment a real package was
    // picked, or — worse — rejected against the ₦1500 floor before the user even knew which
    // provider/package they were paying for. destination_account/phone/email are still listed
    // as a safety net, though the fast path below collects destination_account earlier.
    TV: { min: 1500, max: 100000, required: ['destination_account', 'phone', 'email'] },
    BANK_TRANSFER: { min: 500, max: 500000, required: ['amount_ngn', 'destination_account', 'provider'] },
    EDUCATION: { min: 1000, max: 50000, required: ['amount_ngn', 'destination_account', 'phone', 'email'] }
};

// ⚡ Nigerian network prefixes — kept in sync with the list in intentEngine.ts's SYSTEM_PROMPT
// so the AI's inference and this deterministic fallback can never disagree. The old table was
// missing several live prefixes (MTN 0814; Airtel 0708/0901; Glo 0815), which is why some
// numbers were mis-detected (e.g. a Glo 0815 number falling through and being guessed wrong).
const NETWORK_PREFIXES: Record<string, string[]> = {
  mtn:    ["0803","0806","0703","0706","0813","0816","0810","0814","0903","0906","0913","0916"],
  airtel: ["0802","0808","0708","0812","0701","0902","0907","0901","0912"],
  glo:    ["0805","0807","0705","0815","0811","0905","0915"],
  etisalat:["0809","0817","0818","0909","0908"],
};

const detectNetwork = (phone: any): string | null => {
  if (!phone) return null;
  const phoneStr = String(phone).replace(/\D/g, '').replace(/^234/, '0');
  const prefix = phoneStr.padStart(11, '0').substring(0, 4);
  for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) return network;
  }
  return null;
};

// A bare "Hey"/"Good morning" carries zero financial content — it deserves a short, warm
// reply, not the full capability menu (which reads like a wall of text for a plain greeting).
// Anchored to the WHOLE message so "hey buy me airtime" still falls through to real parsing.
const GREETING_RE = /^(hi+|hey+|hell+o+|yo+|sup|howdy|hola|good\s*(morning|afternoon|evening|day)|what'?s\s*up)[\s!.?]*$/i;

// ⚡ "Buy airtime to my WhatsApp number/account" / "recharge me" / "for myself" — WhatsApp's
// identity IS a phone number (platform_id is the sender's own wa_id), unlike Telegram/X where
// it's an opaque chat id. Shared between the linked-user flow and guest mode (both use the
// same wa_id) so a self-referential phrase is recognized identically in both places.
// Matches "number"/"account"/"line" after "my (whatsapp)", a bare "my whatsapp" with nothing
// after it, "myself", "recharge me", and "for me".
const WHATSAPP_SELF_REFERENCE_RE = /\bmy\s*(whatsapp\s*)?(number|account|line)\b|\bmy\s*whatsapp\b|\brecharge\s*me\b|\bmyself\b|\bfor\s*me\b/i;

// 🔗 CHANNEL-AWARE PAYMENT LINK
//
// 🔴 THE BUG THIS FIXES: the payment CTA was hardcoded as Markdown — `*[Tap here](url)*` —
// and sent byte-identical to all three channels. ONLY Telegram parses that: its sendMessage
// call passes `parse_mode: 'Markdown'`. WhatsApp's Cloud API (see src/lib/whatsapp.ts — plain
// `text: { body }`, no parse mode; it only understands *bold*/_italic_/`code`) and X DMs have
// no bracket-link syntax at all, so users on those channels saw the RAW string
// "*[Tap here to approve & pay](https://abapays.com/?pay=...)*" on the single most important
// message in the whole flow — the one they're supposed to tap to actually pay.
//
// Telegram keeps the clean hyperlink; WhatsApp/X get the bare URL on its own line, which both
// clients auto-linkify into a tappable link.
function payLink(label: string, url: string, platform: string): string {
  return String(platform).toUpperCase() === 'TELEGRAM'
    ? `👉 *[${label}](${url})*`
    : `👉 *${label}:*\n${url}`;
}

// Human-phrased guesses for the "did you mean...?" suggestion below — keeps the bot on-task
// (always steering back toward an actual bill-pay action) instead of a flat capability dump.
const INTENT_GUESS_LABELS: Record<string, string> = {
    VEND_AIRTIME: 'top up airtime',
    VEND_DATA: 'buy a data bundle',
    ELECTRICITY: 'pay an electricity bill',
    TV: 'subscribe to or renew a cable TV package',
    BANK_TRANSFER: 'make a bank transfer',
    EDUCATION: 'buy an education PIN (WAEC/JAMB)',
    TRANSACTION_HISTORY: 'check your transaction history',
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
    // Without this, "Balance" typed mid-flow never triggered the CONTEXT PIVOT — the user
    // stayed trapped in whatever field the bot was waiting on, getting the same "reply with
    // the Target Number/Account" prompt back no matter how many times they asked.
    if (t.includes('balance') || t.includes('how much do i have')) return 'CHECK_BALANCE';
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

// ⚡ EMAIL RECEIPT OPT-IN ⚡
//
// ELECTRICITY/TV/EDUCATION already force-collect an email via SERVICE_RULES (VTpass needs
// it for those categories) — that stays compulsory, unrelated to this. Everyone else
// (airtime, data, bank transfer) never got asked at all. This makes it an explicit,
// validated opt-in for those: reply with an email to get a receipt, or say "skip"/"no" to
// proceed without one — never blocking the payment either way.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_SKIP_WORDS = new Set(['no', 'skip', 'none', 'nope', 'no thanks', 'nothanks', 'n/a', 'na', 'nah']);

function alreadyHasEmail(d: any): boolean {
    return !!(d.email || d.customer_email);
}

function needsEmailOptIn(d: any): boolean {
    if (d.email_choice_made) return false;
    if (alreadyHasEmail(d)) return false; // already mandatory for this category, or already answered
    return true;
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

// ⚡ CABLE PACKAGE LIST — pins the smartcard's CURRENT package as a "Renew" option ⚡
//
// VTpass's merchant-verify genuinely returns `Current_Bouquet`/`Renewal_Amount` for DStv/GOtv
// (confirmed from the live web app, which already reads and displays both — see
// src/lib/deai/services.ts's VerifiedAccount comment for how this was verified). Previously
// the chat/agent flow discarded both fields entirely, so a renewal REQUIRED a separate
// "1. Renew  2. Change" question followed by the user typing an arbitrary amount blind — it
// had no way to show what the current package even was, let alone its price.
//
// Builds ONE combined list — a pinned "Renew: <bouquet>" entry first (when known), then every
// real package — used identically at render time AND in the reply handler, so the two can
// never see a different list. Returns null when there's nothing to pin (non-renewable
// provider, or verify simply didn't return the fields this time) — callers fall back to the
// existing plain package list / explicit renew-or-change question in that case.
function buildCablePackageOptions(
    variations: Option[],
    provider: string | null | undefined,
    currentBouquet: string | null | undefined,
    renewalAmount: number | null | undefined,
): Option[] | null {
    if (!supportsRenew(provider) || !renewalAmount || renewalAmount <= 0) return null;
    const renewOption: Option = {
        id: '__RENEW__',
        label: `Renew: ${currentBouquet || 'your current package'}`,
        price: renewalAmount,
    };
    return [renewOption, ...variations];
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

// ⚡ Local-currency breakdown: each token's value shown IN the requested currency (₦), not
// as a raw stablecoin amount. Stablecoins are ~$1, so tokenAmount × rate is the fiat value.
// Zero-balance tokens are hidden to keep it readable.
function formatChainBalancesInFiat(
    balances: { celo: Record<string, string>; base: Record<string, string> },
    rate: number,
    symbol: string,
): string {
    const fmt = (amt: string | undefined) => `${symbol}${((Number(amt) || 0) * rate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const line = (label: string, bals: Record<string, string>, keys: [string, string][]) => {
        const parts = keys
            .filter(([k]) => (Number(bals[k]) || 0) > 0)
            .map(([k, lbl]) => `${lbl} ${fmt(bals[k])}`);
        return parts.length ? `${label} ${parts.join(' | ')}` : null;
    };
    const celo = line('⚫ Celo:', balances.celo, [['USD₮', 'USDT'], ['USDC', 'USDC'], ['USDm', 'cUSD']]);
    const base = line('🔵 Base:', balances.base, [['USD₮', 'USDT'], ['USDC', 'USDC']]);
    return [celo, base].filter(Boolean).join('\n') || `_No stablecoin balance yet._`;
}

// ⚡ Renders the numbered token-choice list shown during chat checkout, WITH each token's
// wallet balance and agent-approved spend limit alongside it — previously showed balance
// alone (or, from the AWAITING_CHAIN reply handler, neither), leaving the user to guess
// which token they actually have room to pay with instead of just picking blind and hitting
// a "no allowance" wall two steps later.
async function renderTokenChoicesWithAllowance(wallet: string, chain: 'CELO' | 'BASE'): Promise<string> {
    const available = tokensForChain(chain);
    const [balances, allowances] = await Promise.all([
        fetchCryptoBalances(wallet, chain),
        Promise.all(available.map((sym) => getRemainingAllowance(wallet, sym, chain))),
    ]);

    return available
        .map((sym, i) => {
            const bal = (balances as Record<string, string>)[sym] ?? '0.0000';
            const allowance = allowances[i];
            const approved = allowance.ok ? allowance.remaining.toFixed(2) : '0.00';
            return `*${i + 1}.* ${sym} — balance _${bal}_ · approved limit _${approved}_`;
        })
        .join('\n');
}

// ⚡ Every token/chain the user has actually FUNDED an agent allowance for (remaining > 0),
// across both chains, WITH the actual wallet balance alongside each — otherwise the "which
// balance?" prompt only showed the approved limit (a number that says nothing about whether
// the tokens are actually there right now), while every OTHER token-choice list in this file
// (renderTokenChoicesWithAllowance) shows both. A schedule with a real allowance but an empty
// wallet is exactly the case the balance-too-low check further down exists to catch — showing
// the balance UP FRONT lets the user see that before picking, not after confirming.
async function listFundedAllowances(wallet: string): Promise<{ token: string; chain: 'CELO' | 'BASE'; remaining: number; held: string }[]> {
    if (!wallet) return [];
    const chains: ('CELO' | 'BASE')[] = ['CELO', 'BASE'];
    const out: { token: string; chain: 'CELO' | 'BASE'; remaining: number; held: string }[] = [];
    await Promise.all(chains.map(async (chain) => {
        const toks = tokensForChain(chain);
        const [allowances, balances] = await Promise.all([
            Promise.all(toks.map((sym) => getRemainingAllowance(wallet, sym, chain))),
            fetchCryptoBalances(wallet, chain),
        ]);
        toks.forEach((sym, i) => {
            const a = allowances[i];
            if (a.ok && a.remaining > 0) {
                out.push({ token: sym, chain, remaining: a.remaining, held: (balances as Record<string, string>)[sym] ?? '0.0000' });
            }
        });
    }));
    return out;
}

// ⚡ Builds the schedule confirmation (or the "which balance?" ambiguity prompt) and stashes
// the pending schedule for the PIN step. Extracted so it can be reached from two places: the
// main scheduling parse, and the AWAITING_SCHEDULE_ALLOWANCE reply handler once the user has
// picked which funded allowance to use. Re-entrant: if selected_token/chain are already set
// (the user named them, or just chose one), it skips straight to the confirm.
async function buildScheduleConfirm(
    intentData: any, wallet: string, platform: string, platform_id: string,
    approvedToken?: string, approvedChain?: string,
): Promise<NextResponse> {
    const isOneOffFuture = !!intentData.schedule_run_at;

    // ⚡ ASK ONLY WHEN AMBIGUOUS — if the user never named a token/chain and has MORE THAN ONE
    // funded allowance, let them choose instead of silently picking the linked default. Exactly
    // one funded allowance → use it (nothing to choose). Zero → fall through; the "no approved
    // limit" note below explains what to do.
    if (!intentData.selected_token && !intentData.chain) {
        const funded = await listFundedAllowances(wallet);
        if (funded.length > 1) {
            intentData.schedule_allowance_options = funded.map((f) => ({ token: f.token, chain: f.chain }));
            await supabase.from('deai_sessions').upsert({
                chat_id: platform_id, platform, intent_data: intentData,
                status: 'AWAITING_SCHEDULE_ALLOWANCE', expires_at: new Date(Date.now() + 300000).toISOString(),
            }, { onConflict: 'chat_id' });
            return NextResponse.json({
                action: 'REPLY',
                message: [
                    `💳 *Which balance should this schedule pay from?*`,
                    ``,
                    ...funded.map((o, i) => `*${i + 1}.* ${o.token} on ${o.chain} — balance _${o.held}_ · approved limit _${o.remaining.toFixed(2)}_`),
                    ``,
                    `Just reply with the number.`,
                ].join('\n'),
            });
        }
        if (funded.length === 1) {
            intentData.selected_token = funded[0].token;
            intentData.chain = funded[0].chain;
        }
    }

    const serviceID = resolveServiceId(intentData.intent, intentData.provider) || intentData.provider;
    const category = intentData.intent === 'ELECTRICITY' ? 'ELECTRICITY'
                   : intentData.intent === 'TV' ? 'CABLE'
                   : intentData.intent === 'VEND_DATA' ? 'DATA' : 'AIRTIME';

    const tokenSym = intentData.selected_token || approvedToken || 'USD₮';
    const schedChain = (intentData.chain || approvedChain || 'CELO').toUpperCase();
    const allowance = await getRemainingAllowance(wallet, tokenSym, schedChain);

    const schedRate = await getExchangeRate();
    const neededCrypto = Number(intentData.amount_ngn) / schedRate;
    const schedBalances = await fetchCryptoBalances(wallet, schedChain);
    const heldToken = Number(schedBalances[tokenSym] ?? 0);
    const canAutoPay = allowance.ok && allowance.remaining >= neededCrypto;

    if (canAutoPay && heldToken < neededCrypto) {
        return NextResponse.json({
            action: 'REPLY',
            message: `⚠️ *Balance too low for this schedule.*\n\nThis needs about ${neededCrypto.toFixed(4)} ${tokenSym} on ${schedChain}, but your balance is ${heldToken.toFixed(4)} ${tokenSym}.\n\nTop up first, then set the schedule again — I won't create one that can't actually run.`,
        });
    }

    const schedFreq = isOneOffFuture ? 'once' : (intentData.frequency || 'monthly');
    const schedDow = intentData.day_of_week;
    const schedDom = intentData.day_of_month;
    const minutesAway = isOneOffFuture ? Math.max(1, Math.round((new Date(intentData.schedule_run_at).getTime() - Date.now()) / 60_000)) : 0;
    const when = isOneOffFuture
        ? `once, in about ${minutesAway} minute${minutesAway === 1 ? '' : 's'}`
        : schedFreq === 'weekly'
        ? `every ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][schedDow ?? 0]}`
        : schedFreq === 'daily' ? 'every day'
        : `on the ${schedDom}th of each month`;

    intentData.pending_schedule = {
        service_id: serviceID,
        service_category: category,
        provider: intentData.provider,
        billers_code: intentData.destination_account,
        amount_ngn: Number(intentData.amount_ngn),
        meter_type: intentData.meter_type || null,
        blockchain: schedChain,
        token_used: tokenSym,
        frequency: schedFreq,
        day_of_week: isOneOffFuture ? null : schedDow,
        day_of_month: isOneOffFuture ? null : schedDom,
        run_once_at: isOneOffFuture ? intentData.schedule_run_at : null,
        auto_execute: canAutoPay,
        when,
        is_one_off: isOneOffFuture,
        allowance_remaining: allowance.ok ? allowance.remaining : 0,
    };
    await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: intentData,
        status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString(),
    }, { onConflict: 'chat_id' });

    const autoNote = canAutoPay
        ? `🤖 It'll *pay automatically* from your approved limit (${allowance.remaining.toFixed(2)} ${tokenSym} on ${schedChain}).`
        : platform === 'TELEGRAM'
            ? `🔔 I'll *send you a one-tap payment link* here when it's due (you have no auto-pay limit approved).`
            : `⚠️ You have no approved spend limit, so this can't auto-pay — approve one for ${tokenSym} on ${schedChain} in the app before it's due, or it won't run.`;

    return NextResponse.json({
        action: 'REPLY',
        message: [
            `${isOneOffFuture ? '⏱' : '🔁'} *Confirm this ${isOneOffFuture ? 'scheduled payment' : 'automation'}*`,
            ``,
            `*${intentData.provider} ${category}* — ₦${Number(intentData.amount_ngn).toLocaleString()}`,
            `📱 ${intentData.destination_account}`,
            `📅 ${when}`,
            `💳 ${tokenSym} on ${schedChain}`,
            ``,
            autoNote,
            ``,
            `🔒 Reply with your *PIN* to set it up.`,
        ].join('\n'),
    });
}

// Carries the detected language + the user's message out of handleCore so the POST wrapper
// can localize the finished reply (see humanizeReply). Purely a decoration channel — the
// reply's FACTS are already fixed by handleCore; the wrapper only rewrites the prose.
//
// `isPinEntry` is a SEPARATE signal for the channel webhooks: true whenever this turn's
// incoming text was actually consumed as a PIN attempt (right, wrong, or locked-out — all
// three exit the AWAITING_PIN branch below). Telegram/WhatsApp/X previously decided whether
// to delete/advise-deleting the user's message with a bare `/^\d{4,6}$/` regex on the RAW
// TEXT, with no idea whether a PIN was actually being asked for — so typing "1500" as an
// amount, a meter-number fragment, or any other 4-6 digit value got treated as a PIN and
// (on Telegram, which can actually delete messages) silently removed, or (WhatsApp/X)
// wrongly advised the user to delete it. This flag lets each webhook ask the one system that
// actually knows: was AWAITING_PIN the state when this text arrived?
interface HumanizeCtx { lang?: string; userText?: string; channel?: string; isPinEntry?: boolean }

export async function POST(req: Request) {
  const ctx: HumanizeCtx = {};
  const res = await handleCore(req, ctx);

  // ⚡ STAMP isPinEntry ONTO THE RESPONSE BODY — this is the only way the channel webhooks
  // (which only ever see the JSON body, never `ctx` itself) can learn whether this turn's
  // text was actually a PIN attempt. Runs unconditionally (not just on the localization path
  // below), since English-language replies previously skipped re-serialization entirely and
  // isPinEntry would never have reached the response.
  //
  // ⚡ LOCALIZE THE REPLY into the user's language / tone / channel style — safely. Only when
  // a non-English language was detected; the humanizer itself verifies no number, hash, or
  // link is altered and falls back to the original otherwise (see src/lib/deai/humanize.ts).
  try {
    const data = await res.clone().json();
    if (data?.action === 'REPLY' && typeof data.message === 'string') {
      let message = data.message;
      if (ctx.lang && ctx.lang !== 'en') {
        try {
          const localized = await humanizeReply(message, { language: ctx.lang, channel: ctx.channel || '', userText: ctx.userText });
          if (localized) message = localized;
        } catch { /* any hiccup: fall back to the original, unlocalized reply */ }
      }
      return NextResponse.json({ ...data, message, isPinEntry: !!ctx.isPinEntry }, { status: res.status });
    }
  } catch { /* any hiccup (e.g. non-JSON body): fall through to the original response untouched */ }
  return res;
}

async function handleCore(req: Request, ctx: HumanizeCtx): Promise<NextResponse> {
  try {
    // 🔐 INTERNAL ONLY: this route is the DeAI "brain" and must only be reachable
    // via our own bot webhook routes. Without this check, anyone who knows a
    // victim's chat ID / phone number / X ID could impersonate them directly:
    // read their fiat & crypto balances, read their transaction history, and
    // brute-force their 4-digit PIN in unlimited batches.
    if (!verifyInternalRequest(req)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let { platform, platform_id, text, chat_type } = await req.json();
    ctx.userText = typeof text === 'string' ? text : '';
    ctx.channel = platform;

    // 🔐 INPUT VALIDATION: reject malformed payloads before they touch any logic
    if (typeof text !== 'string' || typeof platform_id !== 'string' || !platform_id || text.length > 1000) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const channel = platform === 'TELEGRAM' ? 'TELEGRAM' : platform === 'WHATSAPP' ? 'WHATSAPP' : 'X';
    // Only Telegram's webhook currently sends this — WhatsApp/X callers omit it, which
    // defaults to 'private' below and preserves their existing (DM-only) behaviour untouched.
    const isGroupChat = typeof chat_type === 'string' && chat_type !== 'private';

    // ⚡ LINK-CODE CLAIM ⚡
    // The user links a channel from the APP (where their wallet is), gets a one-time code,
    // and sends it to the bot here. This binds their chat id to their wallet. Works
    // identically for Telegram, WhatsApp, and X.
    const maybeCode = text.trim().toUpperCase();
    if (/^ABA-[A-F0-9]{6}$/.test(maybeCode)) {
      // ⚡ DM-ONLY — a link code is a one-time credential. Typing it into a group puts it in
      // front of every member for as long as the message is visible; anyone fast enough could
      // claim it before its rightful owner. Wallet linking only ever happens in a private chat.
      if (isGroupChat) {
        return NextResponse.json({ action: 'REPLY', message: '🔒 For your security, please DM me directly to link your wallet — not in a group.' });
      }

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

      // ⚡ RE-LINK DETECTION — agent_links has a unique constraint on (channel, channel_user_id),
      // so if THIS chat/account is already verified against a DIFFERENT wallet, the update below
      // would fail the constraint and previously surfaced only as a generic "couldn't complete
      // linking" — giving the user no idea what actually went wrong or how to fix it. Check for
      // this specific, common case up front so we can say exactly what's happening.
      const { data: existingLink } = await supabase
        .from('agent_links')
        .select('id, wallet_address')
        .eq('channel', channel)
        .eq('channel_user_id', platform_id)
        .eq('link_verified', true)
        .maybeSingle();

      let wasRelink = false;
      if (existingLink) {
        const sameWallet = String((existingLink as any).wallet_address).toLowerCase() === String((pendingLink as any).wallet_address).toLowerCase();
        if (sameWallet) {
          // Re-linking the same channel to the same wallet (e.g. refreshing a PIN or the
          // approved token/chain) — replace the stale row rather than erroring. Flagged so
          // the confirmation below says explicitly that a previous link existed and its PIN
          // was replaced, instead of a plain "Linked!" that looks like a silent first-time
          // link (which is confusing, and — if the user DIDN'T initiate this — a signal
          // their wallet may be compromised that they'd otherwise never see).
          await supabase.from('agent_links').delete().eq('id', (existingLink as any).id);
          wasRelink = true;
        } else {
          const otherWallet = String((existingLink as any).wallet_address);
          const channelLabel = channel === 'TELEGRAM' ? 'Telegram' : channel === 'WHATSAPP' ? 'WhatsApp' : 'X';
          return NextResponse.json({
            action: 'REPLY',
            message: `⚠️ *Already linked elsewhere*\n\nYour ${channelLabel} is already linked to wallet \`${otherWallet.slice(0, 6)}...${otherWallet.slice(-4)}\`.\n\nTo link a different wallet, first open the *Agent Hub* tab in the AbaPay app (using that wallet) and unlink this ${channelLabel} channel — then come back and send this same code again.`,
          });
        }
      }

      const { error: claimErr } = await supabase
        .from('agent_links')
        .update({ channel_user_id: platform_id, link_verified: true, link_code: null })
        .eq('id', (pendingLink as any).id);

      if (claimErr) {
        console.error('[DeAI] link claim failed:', claimErr.message);
        return NextResponse.json({ action: 'REPLY', message: "⚠️ Couldn't complete linking — that account may already be linked elsewhere. Check the Agent Hub tab in the app, or try generating a fresh code." });
      }

      const w = (pendingLink as any).wallet_address;
      return NextResponse.json({
        action: 'REPLY',
        message: wasRelink
          ? `🔄 *Re-linked!*\n\nThis chat was already linked to wallet \`${w.slice(0, 6)}...${w.slice(-4)}\` — your previous link (and its PIN) has been replaced with this new one.\n\n_If you didn't do this yourself, revoke your agent allowance in the app immediately._`
          : `✅ *Linked!*\n\nWallet: \`${w.slice(0, 6)}...${w.slice(-4)}\`\n\nYou can now pay bills right here — just tell me what you need, then confirm with your PIN.\n\n_Try: "Send 500 airtime to 08012345678"_`,
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
        // What the user actually approved an on-chain allowance for when they linked (see
        // AgentHub.tsx's startLink) — the relay-vs-link decision below must default to THIS,
        // not a hardcoded token/chain, or an allowance approved in e.g. USDC would never be
        // found (checked under the wrong token) and every payment would silently fall back
        // to the deep-link path even though the user has a working allowance.
        approved_token: (link as any).approved_token || 'USD₮',
        approved_chain: (link as any).approved_chain || 'CELO',
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

    // ⚡ GUEST MODE — no wallet linked yet.
    //
    // Previously this was a hard early-return with its OWN crude, one-shot regex/AI parse —
    // no field-by-field collection, no provider disambiguation, no electricity/meter
    // verification, no duplicate-payment guard, none of the hardening the linked-user flow
    // has. A guest asking for something that needed a follow-up question (missing amount, an
    // ambiguous provider, an unverified meter) just fell through to a generic "here's what I
    // can do" menu instead of actually being asked. And because that whole branch never
    // touched `deai_sessions`, a guest could never have a genuine multi-turn conversation at
    // all — every message was parsed in total isolation.
    //
    // A guest CAN do everything a linked user can except confirm with a PIN (there's no PIN
    // to check and no on-chain allowance to spend from) — so instead of a separate, thinner
    // implementation, a guest now flows through the EXACT SAME state machine as a linked user
    // (session-backed AWAITING_DETAILS/FIELD/PROVIDER/CABLE_ACTION/PLAN_CATEGORY/VARIATION/
    // METER_TYPE — all of it is service-level, not wallet-level, so none of it needs to
    // change for a guest). The only two things that genuinely don't apply without a linked
    // wallet:
    //   1. Chain/token selection (AWAITING_CHAIN/AWAITING_TOKEN) — that's choosing which
    //      on-chain ALLOWANCE to spend from, a concept that doesn't exist without one. Skipped
    //      for guests at the chain-selection choke point (search "isGuest" further down) —
    //      straight to the deep link once all SERVICE fields are collected.
    //   2. The final PIN prompt — replaced by the exact same "Path B" deep-link hand-off a
    //      LINKED user with no allowance already gets (see the AWAITING_PIN handler above).
    // Everything else — verification, disambiguation, duplicate checks, error messages — is
    // now identically hardened for guests and linked users, because it's the same code.
    //
    // Wallet-only intents (balance, history, schedules) are separately redirected below
    // (search "isGuest" in the CHECK_BALANCE/TRANSACTION_HISTORY/LIST_SCHEDULES section) —
    // there is no wallet on file for a guest to check any of those against.
    const isGuest = !identity || !identity.is_active;

    // Session load moved up from just below the guest-greeting block (where it used to sit)
    // so the ONBOARDING GUIDE check below — which needs `session` to know whether a tour is
    // mid-flight — can run BEFORE that block's early-return on a bare "hi", which would
    // otherwise swallow a brand-new guest's very first message before onboarding ever saw it.
    let { data: session } = await supabase.from('deai_sessions').select('*').eq('chat_id', platform_id).single();

    // ⚡ ABANDONED-TRANSACTION DETECTION ⚡
    //
    // Every session write sets expires_at (5 min for most steps, 10 for AWAITING_PIN), but
    // NOTHING ever actually checked it — a user who went quiet mid-flow (network drop, closed
    // the app, distracted) would have their stale intent resumed days later exactly where
    // they left off: wrong amount, wrong recipient, a PIN prompt for a bill they've forgotten
    // about. Enforce it here, once, right after loading: a session past its own expiry is
    // treated as if it doesn't exist, so the very next message starts a clean intent instead
    // of silently reviving a long-abandoned one. This does NOT touch pre-flight transaction
    // rows — those already have their own generic cleanup (see cleanupStalePreflights) that
    // fires regardless of session state.
    if (session && session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      session = null;
    }

    // 🧭 ONBOARDING GUIDE — see src/lib/deai/onboarding.ts.
    //
    // Auto-starts exactly once, on a chat's very first-ever message (no `user_onboarding` row
    // yet) — and never again after that, whether the user finishes it, cancels it, or ignores
    // it, so a returning user's own earlier decision is remembered instead of the tour
    // re-interrupting every conversation. Replayable on demand from any state via GUIDE/TOUR.
    // Runs before the guest-greeting shortcut below so a brand-new guest's opening "hi" still
    // triggers it instead of being swallowed by that shortcut's own reply.
    const rawInput = text.trim().toLowerCase();

    if (session?.status === 'AWAITING_ONBOARDING') {
      const step = session.intent_data?.onboarding_step ?? 0;
      const pendingText = typeof session.intent_data?.pending_text === 'string' ? session.intent_data.pending_text : '';

      if (ONBOARDING_NEXT_RE.test(rawInput)) {
        const nextStep = step + 1;
        if (isLastOnboardingStep(nextStep)) {
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
          await supabase.from('user_onboarding').update({ completed: true, current_step: nextStep, updated_at: new Date().toISOString() }).eq('platform', platform).eq('channel_id', platform_id);
        } else {
          await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: { onboarding_step: nextStep, pending_text: pendingText },
            status: 'AWAITING_ONBOARDING', expires_at: new Date(Date.now() + 600000).toISOString(),
          }, { onConflict: 'chat_id' });
        }
        return NextResponse.json({ action: 'REPLY', message: renderOnboardingStep(nextStep) });
      }

      // Dismissed (CANCEL/SKIP) or the user just typed something else instead of NEXT/CANCEL —
      // either way, stop showing the tour. If their very first-ever message (before the tour
      // intercepted it) looked like a real request, re-process THAT text now instead of
      // silently dropping it — a new user's opening message is often exactly what they came to
      // do. `session` is nulled so none of the AWAITING_* handling below mistakes it for a
      // live transaction.
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      await supabase.from('user_onboarding').update({ dismissed: true, updated_at: new Date().toISOString() }).eq('platform', platform).eq('channel_id', platform_id);
      session = null;

      if (ONBOARDING_CANCEL_RE.test(rawInput) || rawInput.length === 0) {
        if (pendingText) {
          text = pendingText;
        } else {
          return NextResponse.json({ action: 'REPLY', message: "👍 No problem — tell me what you'd like to do, e.g. \"buy 500 MTN airtime for 08012345678\"." });
        }
      }
      // else: fall through with `text` unchanged — it's already the real message they typed.
    } else if (ONBOARDING_TRIGGER_RE.test(rawInput)) {
      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: { onboarding_step: 0 },
        status: 'AWAITING_ONBOARDING', expires_at: new Date(Date.now() + 600000).toISOString(),
      }, { onConflict: 'chat_id' });
      return NextResponse.json({ action: 'REPLY', message: renderOnboardingStep(0) });
    } else {
      const { data: onboardingRecord } = await supabase
        .from('user_onboarding')
        .select('platform')
        .eq('platform', platform)
        .eq('channel_id', platform_id)
        .maybeSingle();

      if (!onboardingRecord) {
        await supabase.from('user_onboarding').insert({ platform, channel_id: platform_id });
        // Stash the very first message if it looks like a real request (not a bare
        // greeting/command) so cancelling the tour can re-process it instead of losing it.
        const looksLikeRealRequest = rawInput.length > 3 && !GREETING_RE.test(rawInput) && !['start', 'help'].includes(rawInput);
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform,
          intent_data: { onboarding_step: 0, pending_text: looksLikeRealRequest ? text : '' },
          status: 'AWAITING_ONBOARDING', expires_at: new Date(Date.now() + 600000).toISOString(),
        }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: renderOnboardingStep(0) });
      }
    }

    if (isGuest) {
      const gt = text.trim().toLowerCase();
      if (GREETING_RE.test(gt)) {
        return NextResponse.json({
          action: 'REPLY',
          message: `👋 Hey! I can help you pay bills — airtime, data, electricity, cable and more.\n\nYou're not linked to a wallet yet, so I'll hand you a secure link to finish each payment in your web3 browser. Just tell me what you need, e.g. _"buy 500 MTN airtime for 08012345678"_.\n\n_Want to skip the link every time and pay right here with just a PIN? Link once at https://abapays.com._`,
        });
      }
      if (gt.length < 25 && /(thank|thanks|thank you|ok|okay|cool|nice|great|👍|alright)/i.test(gt)) {
        return NextResponse.json({ action: 'REPLY', message: `You're welcome! 🙌 Whenever you're ready to pay a bill, just tell me what you need.` });
      }
    }

    const currentCountry = globalUser?.country_code || 'NG';
    const currencySymbol = currentCountry === 'NG' ? '₦' : (currentCountry === 'GH' ? 'GH₵' : '$');
    const fiatBalance = globalUser?.fiat_balance_ngn || 0;
    const crypto = await fetchAllChainBalances(globalUser?.wallet_address || "");

    // Language baseline: reuse whatever language was detected earlier this conversation (stored
    // on the session), so short follow-ups like "1" or a bare PIN still get replies in the
    // user's language. A fresh non-English detection later this turn overrides it.
    if (session?.intent_data?.language) ctx.lang = session.intent_data.language;

    const userInput = text.trim().toLowerCase();

    // ESCAPE HATCHES
    if (userInput === 'cancel') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ action: 'REPLY', message: "🚫 *Transaction Cancelled.*\n\nType *Start* whenever you are ready to make a new request." });
    }

    // 🔒 EMERGENCY REVOKE — genuinely "before anything else", including mid-PIN.
    //
    // A user who suspects their chat is compromised needs to stop the bleeding NOW, not go
    // hunting for the app. This disables the link instantly so the agent can no longer spend.
    //
    // 🔴 THE BUG THIS FIXES: this check used to live ~1300 lines further down, AFTER the
    // `session.status` if/else chain. That chain's AWAITING_PIN branch returns on every single
    // path (correct PIN, wrong PIN, locked), so execution never fell through to it while a PIN
    // was pending — meaning typing "revoke"/"panic"/"stop" at the exact moment a user sees an
    // unexpected "Reply with your PIN" prompt (precisely when they'd panic) was instead
    // evaluated as a WRONG PIN GUESS, burning one of their limited attempts and replying
    // "❌ Incorrect PIN" while agent access stayed fully live. Moving it here — next to
    // `cancel`, above the status chain — makes the "usable from any channel, before anything
    // else" promise actually true. Deliberately placed AFTER `cancel` so that exact word keeps
    // its existing meaning, and it stays anchored (^) so "stop by the shop later" won't fire.
    //
    // NOTE: this is the OPERATIONAL kill. The definitive one is on-chain
    // (setSpendingAllowance(token, 0)) — we tell them to do that too, because it's the only
    // thing that holds if our backend itself is compromised.
    if (/^(revoke|stop|disable|lock|panic|freeze)\b/.test(userInput) && identity?._linkId) {
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

    if (userInput === 'start' || userInput === 'help') {
      await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
      return NextResponse.json({ 
        action: 'REPLY', 
        message: `🌍 *Region:* ${currentCountry}\n💵 *Fiat:* ${currencySymbol}${fiatBalance}\n🪙 *Crypto:*\n${formatChainBalances(crypto)}\n\n👋 *Welcome to AbaPay AI!*\n\nI can help you pay bills and send crypto instantly.\n\n*Try saying:*\n💬 _Buy 500 MTN airtime for 08012345678_\n💬 _Pay 5000 electricity for meter 1122334455_\n📜 _Check my history_`
      });
    }

    // Set by the GO BACK handler below; applied to prependSystemMsg once that's declared.
    let wentBack = false;

    // ⬅️ GO BACK — step back one menu instead of losing the whole request.
    //
    // 🔴 THE BUG THIS FIXES: a user deep in a nested menu ("MTN data" → category → the 12-item
    // Weekly plan list) who typed "Go back" — an entirely natural thing to say, and the obvious
    // move when you picked the wrong category — got "❌ I didn't recognise that." followed by
    // the SAME list again, with no way out except knowing the exact word "cancel" (which throws
    // the whole request away, including the number they already gave). Neither the numeric
    // matchers nor the CONTEXT PIVOT below could help: "go back" names no service, so
    // fallbackIntentMatcher returns UNKNOWN and the pivot never fires.
    //
    // Only states with a meaningful previous step are listed. AWAITING_PIN is deliberately
    // excluded (same reasoning as the pivot: nothing stray may derail a payment one step from
    // completing) — as is AWAITING_SUPPORT_MESSAGE, whose free text could legitimately contain
    // these words.
    if (session && /^(go\s*back|back|previous|prev|return|go back please)\b/i.test(userInput)) {
      const BACK_TARGETS: Record<string, { status: string; clear: string[] }> = {
        // Wrong plan category picked → re-show the category menu, not the plan list.
        AWAITING_VARIATION:  { status: 'AWAITING_PLAN_CATEGORY', clear: ['plan_category', 'variation_code', 'variation_label'] },
        // Backing out of the category menu means reconsidering the provider.
        AWAITING_PLAN_CATEGORY: { status: 'AWAITING_PROVIDER', clear: ['plan_category', 'provider', 'provider_label'] },
        AWAITING_TOKEN:      { status: 'AWAITING_CHAIN', clear: ['selected_token', 'chain'] },
        AWAITING_CABLE_ACTION: { status: 'AWAITING_PROVIDER', clear: ['cable_action', 'provider', 'provider_label'] },
      };
      const target = BACK_TARGETS[session.status];
      if (target) {
        for (const f of target.clear) delete session.intent_data[f];
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform, intent_data: session.intent_data,
          status: target.status, expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });
        // Re-enter the flow so the target state renders its own menu fresh, rather than
        // duplicating every menu's rendering logic here (which would drift out of sync).
        // `wentBack` is applied to prependSystemMsg below, once it's declared.
        session.status = target.status;
        text = '';
        wentBack = true;
      } else {
        // No sensible previous step (e.g. at the very first question) — say so plainly
        // instead of "I didn't recognise that", and point at the real escape hatch.
        return NextResponse.json({
          action: 'REPLY',
          message: `⬅️ There's no previous step from here — this is the first thing I need.\n\n_Reply *cancel* to start over._`,
        });
      }
    }

    // CONTEXT PIVOT — lets a user escape a stuck menu/selection state by clearly naming a
    // different service, instead of being stuck replying "Invalid selection" forever.
    //
    // 🔴 THE BUG THIS FIXES: this only ever checked AWAITING_DETAILS. Every OTHER "waiting for
    // a specific reply" state (picking a data plan category, a variation, a provider, a cable
    // action...) had no escape hatch at all — a user who got derailed into the wrong flow (see
    // the intent-overwrite fix below) and then said "Electric" / "It's electric I want to buy"
    // just kept hearing "Invalid selection. Please reply with a valid number from the list."
    // forever, with no way out except knowing to type the exact word "cancel".
    //
    // Deliberately EXCLUDES AWAITING_PIN (a stray keyword mid-PIN-entry must never abort a
    // payment one step from completing) and AWAITING_SUPPORT_MESSAGE (a support ticket's free
    // text can legitimately contain words like "electric" or "data" without meaning "start
    // over").
    const INTERRUPTIBLE_STATES = new Set([
        'AWAITING_DETAILS', 'AWAITING_FIELD', 'AWAITING_PROVIDER', 'AWAITING_CABLE_ACTION',
        'AWAITING_PLAN_CATEGORY', 'AWAITING_VARIATION', 'AWAITING_CHAIN', 'AWAITING_TOKEN',
        'AWAITING_METER_TYPE', 'AWAITING_EMAIL_CHOICE', 'AWAITING_SCHEDULE_ALLOWANCE',
    ]);
    const freshIntentCheck = fallbackIntentMatcher(text);
    if (session && INTERRUPTIBLE_STATES.has(session.status) && freshIntentCheck !== 'UNKNOWN' && freshIntentCheck !== session.intent_data.intent) {
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
        session = null;
    }

    let isContinuingToAI = false;
    let prependSystemMsg = wentBack ? '⬅️ *Sure — going back.*\n\n' : "";

    // STATE: PIN CONFIRMATION
    if (session?.status === 'AWAITING_PIN') {
      // Every exit from this branch (locked out, correct PIN, wrong PIN) means the incoming
      // text WAS a PIN attempt — set once, unconditionally, so the webhooks know to actually
      // delete/advise-deleting it. See the isPinEntry comment on HumanizeCtx above.
      ctx.isPinEntry = true;

      // 🔒 LOCKOUT GATE — checked BEFORE we even look at the PIN, so a locked identity
      // cannot keep guessing. Survives session resets. Guarded to !isGuest because `identity`
      // is null for a guest — this state should be unreachable for one (guests are forked to
      // a deep link before chain selection, well before AWAITING_PIN is ever entered — see
      // "isGuest" at the chain-selection choke point above), but the guard below turns "should
      // never happen" into "provably can't crash" rather than trusting that invariant alone.
      if (!isGuest && identity._linkId) {
        const gateCheck = await checkPinAllowed(identity._linkId);
        if (!gateCheck.allowed) {
          await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
          return NextResponse.json({ action: 'REPLY', message: gateCheck.message! });
        }
      }

      // ⚡ GUEST SAFETY NET — this state should be unreachable for a guest (see above), but if
      // it's ever reached anyway (e.g. a future code path that sets AWAITING_PIN without going
      // through the chain-selection choke point), treat it as "final execution reached" and
      // hand back the deep link rather than evaluating a PIN that doesn't exist for `identity`
      // (which is null) — `isGuest ||` short-circuits verifyPin so identity.deai_pin is never
      // touched.
      if (isGuest || verifyPin(text.trim(), identity.deai_pin)) {
        // Correct PIN — wipe the failure counter. (No-op for a guest — never set above.)
        if (!isGuest && identity._linkId) await clearPinFailures(identity._linkId);

        // 🔐 TRANSPARENT MIGRATION: if this PIN was still stored as legacy
        // plaintext, upgrade it to a salted scrypt hash on this successful login.
        // Write back to whichever table this identity actually came from.
        if (!isGuest && !isHashedPin(identity.deai_pin)) {
          const newHash = hashPin(text.trim());
          if (identity._source === 'agent_links') {
            await supabase.from('agent_links').update({ pin_hash: newHash }).eq('id', identity._linkId);
          } else {
            const legacyColumn = platform === 'TELEGRAM' ? 'telegram_chat_id' : platform === 'WHATSAPP' ? 'whatsapp_number' : 'x_twitter_id';
            await supabase.from('deai_identities').update({ deai_pin: newHash }).eq(legacyColumn, platform_id);
          }
        }
        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

        // 🔒 PIN-CONFIRMED BATCH — several recipients in one message. Executes sequentially,
        // NOT in parallel: each payBillFor decrements the same on-chain allowance, and firing
        // them concurrently would race the allowance check against itself (the contract would
        // reject the losers, but with confusing partial results). Sequential also means a
        // mid-batch failure has a well-defined boundary — everything before it definitely
        // moved, everything after it definitely didn't.
        //
        // Reports PER RECIPIENT rather than one blanket success/failure: with real money for
        // several people, "3 of 4 went through, here's the one that didn't" is the only honest
        // summary. Deliberately does NOT abort the rest on a single failure — the remaining
        // recipients are independent payments the user still asked for, and their capacity was
        // already verified; stopping would strand them with no clear way to resume just the
        // missing ones.
        if (!isGuest && session.intent_data?.pending_batch) {
          const pb = session.intent_data.pending_batch;
          const batchRate = await getExchangeRate();
          const lines: string[] = [];
          let okCount = 0;

          for (const item of pb.items as BatchItem[]) {
            const result = await executeAgentPayment({
              userWallet: globalUser?.wallet_address || '',
              item,
              exchangeRate: batchRate,
              sourceChannel: platform,
              email: session.intent_data.email || session.intent_data.customer_email || null,
            });

            const who = `${(item.provider || '').toUpperCase()} ₦${item.amountNgn.toLocaleString()} → ${item.billersCode}`;
            if (result.success) {
              okCount++;
              lines.push(`✅ ${who}`);
            } else if (result.pending) {
              lines.push(`⏳ ${who} — sent, still confirming (don't resend this one)`);
            } else if (result.vendFailed) {
              lines.push(`⚠️ ${who} — paid, but delivery failed; refund on its way`);
            } else {
              lines.push(`❌ ${who} — ${result.message}`);
            }
          }

          // One out-of-band alert for the batch as a whole — the owner should hear about a
          // multi-recipient spend even if someone else is holding the chat.
          try {
            await notifySpendOutOfBand(globalUser?.wallet_address || '', {
              amountNgn: pb.totalNgn,
              amountCrypto: (pb.totalNgn / batchRate).toFixed(6),
              token: (pb.items[0] as BatchItem)?.tokenSymbol || 'USD₮',
              service: `${pb.items.length} payments (batch)`,
              account: `${pb.items.length} recipients`,
              channel: platform,
              txHash: '',
              remaining: '',
            });
          } catch { /* never block on alerting */ }

          return NextResponse.json({
            action: 'REPLY',
            message: [
              okCount === pb.items.length
                ? `✅ *All ${pb.items.length} payments sent — ₦${pb.totalNgn.toLocaleString()}*`
                : `👥 *Batch finished — ${okCount} of ${pb.items.length} went through*`,
              ``,
              ...lines,
            ].join('\n'),
          });
        }

        // 🔒 PIN-CONFIRMED SCHEDULE CREATION — if the pending action is a schedule (not an
        // immediate payment), create the scheduled_bills row now that the PIN is verified.
        // This is what stops a third party with chat access from silently setting up a
        // standing spend. notify_channel/notify_channel_id are stored so the scheduler can
        // report the run's outcome back on THIS channel (fixes the "silent after run" gap).
        // Never true for a guest — scheduling creation is redirected to "link your wallet"
        // well before pending_schedule is ever stashed (see the scheduling section above) —
        // but the guard costs nothing and removes any doubt.
        if (!isGuest && session.intent_data?.pending_schedule) {
          const ps = session.intent_data.pending_schedule;
          const { error: schedErr } = await supabase.from('scheduled_bills').insert({
            wallet_address: (globalUser?.wallet_address || '').toLowerCase(),
            service_id: ps.service_id,
            service_category: ps.service_category,
            provider: ps.provider,
            billers_code: ps.billers_code,
            amount_ngn: ps.amount_ngn,
            meter_type: ps.meter_type,
            blockchain: ps.blockchain,
            token_used: ps.token_used,
            frequency: ps.frequency,
            day_of_week: ps.day_of_week,
            day_of_month: ps.day_of_month,
            run_once_at: ps.run_once_at,
            auto_execute: ps.auto_execute,
            notify_channel: platform,
            notify_channel_id: platform_id,
            notify_telegram: platform === 'TELEGRAM' ? platform_id : null,
            notify_email: session.intent_data.email || session.intent_data.customer_email || null,
            is_active: true,
          });

          if (schedErr) {
            console.error('[DeAI] PIN-confirmed schedule create failed:', schedErr.message);
            return NextResponse.json({ action: 'REPLY', message: "⚠️ Couldn't save that automation. Please try again." });
          }

          return NextResponse.json({
            action: 'REPLY',
            message: [
              `${ps.is_one_off ? '⏱ *Scheduled!*' : '🔁 *Automation set!*'}`,
              ``,
              `*${ps.provider || ''} ${ps.service_category}* — ₦${Number(ps.amount_ngn).toLocaleString()}`,
              `📱 ${ps.billers_code}`,
              `📅 ${ps.when}`,
              ``,
              ps.auto_execute
                ? `🤖 I'll pay it automatically and message you here with the result${ps.is_one_off ? ' once it runs' : ' each time'}.`
                : `🔔 I'll notify you here when it's due.`,
            ].join('\n'),
          });
        }

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
        // Prefer whatever the user explicitly said in THIS conversation (d.chain/d.selected_token);
        // otherwise default to whatever they actually approved an allowance for at link time
        // (globalUser.approved_chain/approved_token), not a hardcoded guess — see the comment
        // on globalUser's construction above for why this matters.
        const chain = (d.chain || globalUser?.approved_chain || 'CELO').toUpperCase();
        const tokenSym = d.selected_token || globalUser?.approved_token || 'USD₮';
        // Shared between Path A's transaction record and Path B's deep link, so they can
        // never drift apart on what a given intent maps to.
        const serviceCategory = d.intent === 'ELECTRICITY' ? 'ELECTRICITY'
                               : d.intent === 'TV' ? 'CABLE'
                               : d.intent === 'VEND_DATA' ? 'DATA' : 'AIRTIME';

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
        // Set specifically when the reason we're about to fall back to Path B is "no/not
        // enough allowance for THIS chain/token" — as opposed to being unlinked, the operator
        // gate blocking, or the relay call itself failing. Lets the deep-link message below
        // explain exactly why, and offer approving a limit as an alternative to paying via
        // link every time. See needsEmailOptIn's sibling reasoning: never blocks the payment.
        let allowanceShortfall: { needed: string; have: string } | null = null;

        if (userWallet) {
          // Reserved outside the try{} so the catch block can always clean it up, even if
          // something throws between creating it and renaming/deleting it.
          let preflightTxHash: string | null = null;
          try {
            const allowance = await getRemainingAllowance(userWallet, tokenSym, chain);
            const rate = await getExchangeRate();
            const amountCrypto = (Number(d.amount_ngn) / rate).toFixed(6);

            if (!allowance.ok || allowance.remaining < Number(amountCrypto)) {
              allowanceShortfall = { needed: amountCrypto, have: allowance.ok ? allowance.remaining.toFixed(2) : '0' };
            }

            if (allowance.ok && allowance.remaining >= Number(amountCrypto)) {
              const serviceID = resolveServiceId(d.intent, d.provider || null) || d.provider || '';
              const vtRequestId = getStrictRequestId();

              // ⚡ THE FIX — relayPayBillFor() only ever submitted payBillFor() on-chain; NOTHING
              // downstream ever called VTpass to actually deliver the service. The webhook that
              // does that requires a matching PENDING row to exist first (see src/app/api/webhook
              // — it fast-exits with no matching record otherwise), and this path never created
              // one. Confirmed via Blockscout that the relayer address has never once called
              // payBillFor in production, so this has never actually shortchanged anyone — but it
              // would have, the moment anyone with a working allowance used it.
              //
              // Mirrors /api/pay's intent_only pattern: write a PENDING row keyed by a
              // preflight_<wallet>_<ts> placeholder BEFORE submitting on-chain, rename it to the
              // real hash on success, delete it on failure. Once renamed, the webhook can also
              // pick this transaction up as a backup if the synchronous vend below is interrupted
              // (server restart, timeout) — same safety net the browser-initiated flow already has.
              const isMainnetDb = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_NETWORK === 'celo' || process.env.NEXT_PUBLIC_NETWORK === 'base';
              const explorerBaseDb = chain === 'BASE'
                ? (isMainnetDb ? 'https://basescan.org' : 'https://sepolia.basescan.org')
                : (isMainnetDb ? 'https://celoscan.io' : 'https://sepolia.celoscan.io');

              preflightTxHash = `preflight_${userWallet}_${Date.now()}`;
              await supabase.from('transactions').upsert({
                tx_hash: preflightTxHash, request_id: vtRequestId, service_category: serviceCategory, service_id: serviceID,
                variation_code: d.variation_code || null, network: d.provider || null, blockchain: chain,
                account_number: d.destination_account, phone: d.phone || null,
                amount_usdt: Number(amountCrypto), amount_naira: Number(d.amount_ngn), fee_naira: Number(d.fee || 0), status: 'PENDING',
                wallet_address: userWallet.toLowerCase(),
                customer_name: d.customer_name || null, customer_address: d.customer_address || null,
                source_channel: platform, token_used: tokenSym,
                meter_account_type: d.meter_type || null, customer_email: d.email || d.customer_email || null,
                operator_id: d.operator_id || null, country_code: d.country_code || null, product_type_id: d.product_type_id || null,
                subscription_type: d.cable_action || null,
                payment_method: 'AGENT_RELAY',
              }, { onConflict: 'tx_hash' });

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
                const txHash = res.txHash as string;

                // Rename the preflight row to the real hash, then atomically lock it —
                // same PENDING-to-PROCESSING pattern /api/pay and the webhook both use, so a
                // retried/duplicate delivery can never double-vend.
                await supabase.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', preflightTxHash);
                preflightTxHash = null; // renamed — nothing left for the catch block to clean up

                const { data: lockedRecord } = await supabase
                  .from('transactions')
                  .update({ status: 'PROCESSING' })
                  .eq('tx_hash', txHash)
                  .eq('status', 'PENDING')
                  .select()
                  .single();

                // 🔒 OUT-OF-BAND SPEND ALERT — sent regardless of vend outcome below, because
                // the money already moved on-chain either way. This is the real defence against
                // someone else having access to the chat: even if an attacker has the PIN, the
                // OWNER is told immediately, by email and on every other linked channel. They can
                // revoke (set limit to 0) before much damage is done.
                try {
                  await notifySpendOutOfBand(globalUser?.wallet_address || '', {
                    amountNgn: Number(d.amount_ngn),
                    amountCrypto,
                    token: tokenSym,
                    service: `${d.provider || ''} ${serviceLabel}`,
                    account: d.destination_account,
                    channel: platform,
                    txHash,
                    remaining: left,
                  });
                } catch { /* never block a successful payment on alerting */ }

                const explorerUrl = `${explorerBaseDb}/tx/${txHash}`;

                if (!lockedRecord) {
                  // Lost the lock race (webhook got there first) — it's already vending; don't
                  // double-vend by calling executeVend again.
                  return NextResponse.json({
                    action: 'REPLY',
                    message: `✅ *Paid!*\n\n🔗 \`${txHash}\`\n\n_Finishing up in the background — check History shortly._`,
                  });
                }

                const vendResult = await executeVend({
                  vtRequestId, txHash, serviceID, serviceCategory, network: d.provider || '', billersCode: d.destination_account,
                  phone: d.phone || null, variation_code: d.variation_code, subscription_type: d.cable_action,
                  amount: amountCrypto, tokenSymbol: tokenSym, vendAmount: Number(d.amount_ngn), displayAmount: undefined,
                  foreignAmount: undefined, isForeign: false, operator_id: d.operator_id, country_code: d.country_code,
                  product_type_id: d.product_type_id, email: d.email || d.customer_email || null,
                  wallet_address: userWallet, blockchain: chain, source_channel: platform,
                  customer_name: d.customer_name, customer_address: d.customer_address,
                  baseRate: rate, explorerUrl,
                });

                if (vendResult.status === 'SUCCESS') {
                  return NextResponse.json({
                    action: 'REPLY',
                    message: [
                      `✅ *Paid!*`,
                      ``,
                      `*${d.provider || ''} ${serviceLabel}* — ₦${Number(d.amount_ngn).toLocaleString()}`,
                      d.customer_name ? `👤 ${d.customer_name}` : null,
                      `📱 ${d.destination_account}`,
                      `⛓️ ${chain} · ${amountCrypto} ${tokenSym}`,
                      vendResult.purchased_code ? `🔑 ${vendResult.purchased_code}` : null,
                      ``,
                      `🔗 \`${txHash}\``,
                      ``,
                      `💳 Remaining agent allowance: *${left} ${tokenSym}*`,
                      `_Your token — your wallet. AbaPay never held your funds._`,
                    ].filter(Boolean).join('\n'),
                  });
                }

                // FAILED_VENDING (executeVend already auto-queued a refund) or TIMEOUT
                // (still processing in the background) — either way the payment itself
                // succeeded, so we don't fall through to Path B; that would offer a link to
                // pay AGAIN for something already charged.
                return NextResponse.json({
                  action: 'REPLY',
                  message: vendResult.status === 'FAILED_VENDING'
                    ? `⚠️ Payment succeeded, but delivering it failed.\n\n🔗 \`${txHash}\`\n\n${vendResult.message || 'Your funds are being refunded — you don\'t need to do anything.'}`
                    : `✅ *Paid!*\n\n🔗 \`${txHash}\`\n\n_Finishing up in the background — check History shortly._`,
                });
              }

              // ⚡ BROADCAST BUT UNCONFIRMED (network/RPC hiccup while waiting for the
              // receipt) — the transaction may still land for real. Falling through to Path
              // B here would hand the user a payment link while the ORIGINAL payment could
              // still confirm moments later — a real double-payment risk, not just a UX
              // annoyance. So: keep the record (rename to the real hash, same as success —
              // never delete it), don't vend yet since we don't know the outcome, and let the
              // webhook's own on-chain confirmation + retry logic resolve it for real once an
              // answer is available, exactly as it already does for the browser-initiated flow.
              if (res.pending && res.txHash) {
                const txHash = res.txHash;
                await supabase.from('transactions').update({ tx_hash: txHash }).eq('tx_hash', preflightTxHash);
                preflightTxHash = null;
                return NextResponse.json({
                  action: 'REPLY',
                  message: `⏳ *Confirming your payment...*\n\n🔗 \`${txHash}\`\n\n_Your payment was sent but we lost connection confirming it. It may still go through — please don't pay again. Check History shortly, or message me again in a minute._`,
                });
              }

              // Relay failed before/without confirming on-chain — nothing was charged.
              // Clean up the preflight row and fall through to the deep link.
              if (preflightTxHash) {
                await supabase.from('transactions').delete().eq('tx_hash', preflightTxHash);
                preflightTxHash = null;
              }
              console.error('[DeAI] Relay failed, falling back to deep link:', res.message);
            }
          } catch (relayErr) {
            console.error('[DeAI] Relay path errored, falling back to deep link:', relayErr);
            if (preflightTxHash) {
              try {
                await supabase.from('transactions').delete().eq('tx_hash', preflightTxHash);
              } catch { /* best-effort cleanup */ }
            }
          }
        }

        // ⚡ PATH B — DEEP-LINK HAND-OFF (no allowance, or relay unavailable)
        // The user signs in the app with their own wallet.
        try {
          const serviceID = resolveServiceId(d.intent, d.provider || null) || d.provider || '';
          const payUrl = createDeepLink(baseUrl, {
            serviceID,
            serviceCategory,
            provider: d.provider || '',
            billersCode: d.destination_account,
            amountNgn: Number(d.amount_ngn),
            variationCode: d.variation_code || undefined,
            meterType: d.meter_type || undefined,
            cableAction: d.cable_action || undefined,
            customerName: d.customer_name || undefined,
            customerAddress: d.customer_address || undefined,
            // Same chain/token resolution as Path A above (falls back to what the user
            // actually approved at link time, not a hardcoded guess).
            chain: chain as 'CELO' | 'BASE',
            token: tokenSym,
            channel: platform,
            chatId: platform_id,
            // Receipt email — either forced by SERVICE_RULES (ELECTRICITY/TV/EDUCATION) or
            // opted into via AWAITING_EMAIL_CHOICE above. The web app pre-fills this from the
            // link (see the deep-link resolution effect in src/app/page.tsx).
            email: d.email || d.customer_email || undefined,
          });

          // Explain WHY they're getting a link, specifically when it's because there's no
          // (or not enough) approved allowance for this exact chain/token — rather than the
          // same "PIN Verified!" framing regardless of cause. Still hands them a working link
          // either way, so this never blocks the payment; it just makes the choice explicit
          // (pay this one via the link now, or approve a limit so future ones go straight
          // through from chat).
          const summary = allowanceShortfall ? [
            `⚠️ *No approved limit for this*`,
            ``,
            `You don't have an agent spend limit approved for *${tokenSym} on ${chain}* — need ${allowanceShortfall.needed} ${tokenSym}, approved: ${allowanceShortfall.have} ${tokenSym}.`,
            ``,
            `*${d.provider || ''} ${d.intent === 'ELECTRICITY' ? 'Electricity' : d.intent === 'VEND_DATA' ? 'Data' : d.intent === 'TV' ? 'Cable' : 'Airtime'}* — ₦${Number(d.amount_ngn).toLocaleString()}`,
            d.customer_name ? `👤 ${d.customer_name}` : null,
            `📱 ${d.destination_account}`,
            ``,
            payLink('Tap here to pay this one now', payUrl, platform),
            ``,
            `_Or approve a ${tokenSym}/${chain} spend limit in the app's Agent tab so future payments like this go straight through from chat, no link needed. Link expires in 15 minutes._`,
          ].filter(Boolean).join('\n') : [
            `✅ *PIN Verified!*`,
            ``,
            `*${d.provider || ''} ${d.intent === 'ELECTRICITY' ? 'Electricity' : d.intent === 'VEND_DATA' ? 'Data' : d.intent === 'TV' ? 'Cable' : 'Airtime'}*`,
            d.customer_name ? `👤 ${d.customer_name}` : null,
            `📱 ${d.destination_account}`,
            `💰 ₦${Number(d.amount_ngn).toLocaleString()}`,
            ``,
            payLink('Tap here to approve & pay', payUrl, platform),
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
    // ⚡ STATE: EMAIL RECEIPT OPT-IN ⚡
    // Only entered for categories that don't already force an email (see needsEmailOptIn).
    // Never blocks the payment: "skip"/"no" proceeds with no email at all.
    else if (session?.status === 'AWAITING_EMAIL_CHOICE') {
      const reply = text.trim();
      const normalized = reply.toLowerCase().replace(/[.!]+$/, '');

      if (!EMAIL_SKIP_WORDS.has(normalized)) {
        if (!EMAIL_RE.test(reply)) {
          return NextResponse.json({ action: 'REPLY', message: `⚠️ That doesn't look like a valid email address.\n\n📧 Reply with your email, or say *skip* to continue without a receipt.` });
        }
        session.intent_data.email = reply;
        session.intent_data.customer_email = reply;
      }
      session.intent_data.email_choice_made = true;

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'AWAITING_PIN',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      const d2 = session.intent_data;
      let detailsRow2 = "";
      if (d2.intent === 'VEND_DATA') detailsRow2 = `Plan: ${d2.variation_name}\nNetwork: ${d2.provider?.toUpperCase()}`;
      else if (d2.intent === 'VEND_AIRTIME') detailsRow2 = `Network: ${d2.provider?.toUpperCase()}`;
      else if (d2.intent === 'BANK_TRANSFER') detailsRow2 = `Bank: ${d2.provider?.toUpperCase()}`;
      else detailsRow2 = `Name: ${d2.verified_name || 'N/A'}`;

      const total2 = Number(d2.amount_ngn || 0) + Number(d2.fee || 0);
      return NextResponse.json({
        action: 'REPLY',
        message: `${d2.email ? `✅ Receipt will go to ${d2.email}.` : "👍 No receipt — proceeding without an email."}\n\n🤖 *Final Checkout*\n\nService: ${d2.intent.replace('_', ' ')}\nAccount: ${d2.destination_account}\n${detailsRow2}\nAmount: ${currencySymbol}${d2.amount_ngn || 0}\n*Total: ${currencySymbol}${total2}*\n\n🔒 Reply with your *PIN* to confirm.`,
      });
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

      // Compulsory fields done — ask about a receipt email before PIN, unless this category
      // already forces one (ELECTRICITY/TV/EDUCATION) or the user already answered.
      if (needsEmailOptIn(session.intent_data)) {
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform, intent_data: session.intent_data,
          status: 'AWAITING_EMAIL_CHOICE',
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `✅ Got it.\n\n📧 Want an email receipt? Reply with your email, or say *skip*.` });
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
        // See AWAITING_PLAN_CATEGORY: prependSystemMsg is the "going back" lead-in when set.
        return NextResponse.json({
          action: 'REPLY',
          message: `${prependSystemMsg || "❌ I didn't recognise that.\n\n"}${spec.prompt}\n\n${renderOptions(spec.options)}\n\n_Reply with the number, or the name._`,
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
        // prependSystemMsg is set when the user deliberately stepped back here ("go back") —
        // in that case show the menu with that friendlier lead-in instead of an error they
        // didn't earn. Empty otherwise, so a genuinely unrecognised reply still says so.
        return NextResponse.json({
          action: 'REPLY',
          message: `${prependSystemMsg || "❌ I didn't recognise that.\n\n"}📦 *What kind of plan?*\n\n${renderCategoryMenu(groups)}\n\n_Reply with the number._`,
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

      // ⚡ CABLE RENEW PIN — rebuilds the SAME combined list (pinned renew + packages) shown
      // at render time, using buildCablePackageOptions so the two can never disagree. Only
      // ever non-null for TV with a known current bouquet/renewal amount (see that function).
      const cableOptions = session.intent_data.intent === 'TV'
        ? buildCablePackageOptions(options, session.intent_data.provider, session.intent_data.cable_current_bouquet, session.intent_data.cable_renewal_amount)
        : null;
      if (cableOptions) options = cableOptions;

      const page = Number(session.intent_data.variation_page) || 0;

      // 🔴 PAGINATION — THE BUG THIS FIXES: a long list (DStv alone has ~40 packages) was
      // dumped as ONE flat numbered wall of text. Now shown PAGE_SIZE at a time; "next"/"more"
      // advances without re-litigating the whole list. A name/id typed directly still matches
      // across the FULL list regardless of page (see matchPagedOption).
      if (isNextPageRequest(text)) {
        const nextPage = page + 1;
        const rendered = renderOptionsPage(options, nextPage, { showPrice: true });
        session.intent_data.variation_page = rendered.page;
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform, intent_data: session.intent_data,
          status: 'AWAITING_VARIATION', expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });
        const footer = rendered.hasMore
          ? `\n\n_Page ${rendered.page + 1}/${rendered.totalPages} — reply *next* to see more, or reply with a number._`
          : `\n\n_Page ${rendered.page + 1}/${rendered.totalPages} (last page) — reply with a number._`;
        return NextResponse.json({ action: 'REPLY', message: `📦 *Choose a plan:*\n\n${rendered.text}${footer}` });
      }

      // Synonyms for the pinned renew slot, kept identical to the old explicit
      // renew-or-change question so either phrasing still works.
      const wantsRenewByWord = cableOptions && /(renew|same|current)/i.test(text.trim());
      const picked = wantsRenewByWord
        ? cableOptions[0]
        : matchPagedOption(text.trim(), options, page);

      if (!picked) {
        const rendered = renderOptionsPage(options, page, { showPrice: true });
        const footer = rendered.hasMore
          ? `\n\n_Page ${rendered.page + 1}/${rendered.totalPages} — reply *next* to see more, or reply with a number._`
          : rendered.totalPages > 1 ? `\n\n_Page ${rendered.page + 1}/${rendered.totalPages} (last page) — reply with a number._` : '';
        return NextResponse.json({
          action: 'REPLY',
          message: `❌ I didn't recognise that.\n\n📦 *Choose a plan:*\n\n${rendered.text}${footer}`,
        });
      }

      delete session.intent_data.variation_page;

      if (picked.id === '__RENEW__') {
        // The pinned renew slot: no variation_code (VTpass renews whatever's already on the
        // account — see contracts/vend.ts's subscription_type='renew' handling), the amount
        // IS the verified renewal amount.
        session.intent_data.cable_action = 'renew';
        session.intent_data.amount_ngn = picked.price;
      } else {
        session.intent_data.cable_action = session.intent_data.intent === 'TV' ? 'change' : session.intent_data.cable_action;
        session.intent_data.variation_code = picked.id;
        session.intent_data.variation_label = picked.label;
        // The plan price IS the amount for these services.
        if (picked.price) session.intent_data.amount_ngn = picked.price;
      }

      await supabase.from('deai_sessions').upsert({
        chat_id: platform_id, platform, intent_data: session.intent_data,
        status: 'ROUTING',
        expires_at: new Date(Date.now() + 300000).toISOString(),
      }, { onConflict: 'chat_id' });

      // Resume from the stored intent and continue into the master sweep.
      session.status = 'AWAITING_DETAILS';
      text = "";
      isContinuingToAI = true;
      prependSystemMsg = picked.id === '__RENEW__'
        ? `✅ *Renewing: ${picked.label.replace(/^Renew:\s*/, '')}* — ₦${Number(picked.price || 0).toLocaleString()}\n\n`
        : `✅ *${picked.label}* — ₦${Number(picked.price || 0).toLocaleString()}\n\n`;
    }
    // STATE: SCHEDULE ALLOWANCE CHOICE ⚡
    // The user has more than one funded agent allowance and didn't name one for this
    // schedule, so we asked which to spend from. Map their numbered reply (or the token
    // name) to the chosen token/chain and re-enter the schedule build.
    else if (session?.status === 'AWAITING_SCHEDULE_ALLOWANCE') {
      const options: { token: string; chain: 'CELO' | 'BASE' }[] = session.intent_data.schedule_allowance_options || [];
      const idx = parseInt(userInput, 10) - 1;
      let choice: { token: string; chain: 'CELO' | 'BASE' } | undefined = options[idx];

      // Accept the token name too (e.g. "USDC", "celo usdc") — not just the numbered slot.
      if (!choice) {
        const norm = userInput.toLowerCase().replace(/[^a-z0-9]/g, '');
        const alias: Record<string, string> = { usdc: 'USDC', usdt: 'USD₮', tether: 'USD₮', usd: 'USD₮', usdm: 'USDm', cusd: 'USDm' };
        const wantToken = alias[norm];
        const wantChain = norm.includes('base') ? 'BASE' : norm.includes('celo') ? 'CELO' : null;
        choice = options.find((o) => (wantToken ? o.token === wantToken : true) && (wantChain ? o.chain === wantChain : true));
      }

      if (!choice) {
        const list = options.map((o, i) => `*${i + 1}.* ${o.token} on ${o.chain}`).join('\n');
        return NextResponse.json({ action: 'REPLY', message: `❌ Reply with the number of the balance to use:\n\n${list}` });
      }

      session.intent_data.selected_token = choice.token;
      session.intent_data.chain = choice.chain;
      delete session.intent_data.schedule_allowance_options;

      return await buildScheduleConfirm(
        session.intent_data, globalUser?.wallet_address || '', platform, platform_id,
        globalUser?.approved_token, globalUser?.approved_chain,
      );
    }
    // STATE: CHAIN SELECTION ⚡
    // Chain was previously hardcoded to CELO, so a user could never pay on Base from chat.
    else if (session?.status === 'AWAITING_CHAIN') {
      // Accept the actual chain name too, not just the numbered choice — a user typing
      // "Celo" clearly means option 1, and rejecting that ("reply with 1 or 2") when the
      // intent is completely unambiguous is exactly the rigid, un-smart behavior users
      // complained about.
      const chainMap: Record<string, 'CELO' | 'BASE'> = {
        '1': 'CELO', 'celo': 'CELO',
        '2': 'BASE', 'base': 'BASE',
      };
      const picked = chainMap[userInput];

      if (!picked) {
        // See AWAITING_PLAN_CATEGORY: prependSystemMsg is the "going back" lead-in when set.
        return NextResponse.json({
          action: 'REPLY',
          message: `${prependSystemMsg || "❌ "}⛓️ *Which chain?*\n\n*1.* Celo\n*2.* Base\n\n_Reply with the number._`,
        });
      }

      session.intent_data.chain = picked;

      // Only offer tokens that actually EXIST on the chosen chain, with balance + approved
      // agent limit alongside each so the user can tell which one they can actually pay
      // with, instead of picking blind and hitting a "no allowance" wall later.
      const list = await renderTokenChoicesWithAllowance(globalUser?.wallet_address || '', picked);

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
      let selected: string | undefined = available[idx];

      // Accept the token's actual name too, not just its numbered position — same
      // reasoning as the chain-selection fix above. Covers the common ways people
      // actually type these (USD₮'s own symbol has a unicode ₮ nobody types by hand).
      if (!selected) {
        const normalized = userInput.replace(/[^a-z0-9]/g, '');
        const aliasMap: Record<string, string> = {
          usdc: 'USDC',
          usdt: 'USD₮', usd: 'USD₮', tether: 'USD₮',
          usdm: 'USDm', cusd: 'USDm',
        };
        const aliasSymbol = aliasMap[normalized];
        if (aliasSymbol) selected = available.find((t) => t === aliasSymbol);
      }

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

      // Ask about a receipt email before PIN, unless already forced/answered (see the other
      // AWAITING_PIN transition above for the full rationale).
      if (needsEmailOptIn(session.intent_data)) {
        await supabase.from('deai_sessions').upsert({
          chat_id: platform_id, platform, intent_data: session.intent_data,
          status: 'AWAITING_EMAIL_CHOICE',
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });
        return NextResponse.json({ action: 'REPLY', message: `📧 Want an email receipt? Reply with your email, or say *skip*.` });
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
          message: `🤖 *Final Checkout*\n\nService: ${session.intent_data.intent.replace('_', ' ')}\nAccount: ${session.intent_data.destination_account}\n${detailsRow}\nAmount: ${currencySymbol}${session.intent_data.amount_ngn || 0}\nPayment: *${selected}*\n*Total: ${currencySymbol}${total}*\n\n🔒 Reply with your *PIN* to confirm.`
      });
    }
    // STATE: METER TYPE
    else if (session?.status === 'AWAITING_METER_TYPE') {
        const typeMap: Record<string, string> = { '1': 'prepaid', '2': 'postpaid' };
        const selectedType = typeMap[userInput];

        if (!selectedType) return NextResponse.json({ action: 'REPLY', message: "❌ Please reply with *1* for Prepaid or *2* for Postpaid." });
        
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
        
        prependSystemMsg = `✅ *Meter Verified!*\nName: ${verification.customer_name}\n${verification.customer_address ? `Address: ${verification.customer_address}\n` : ''}\n`;
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
            // Only a fresh NON-English detection updates the language — a bare "1"/"2" menu
            // reply parses as "en" and must not wipe a Yoruba/Pidgin user's remembered language.
            if (aiParsed?.language && aiParsed.language !== 'en') ctx.lang = aiParsed.language;

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

            // 🔴 THE BUG THIS FIXES: parseIntent() re-parses each message in complete
            // isolation, with zero memory of the conversation. Mid-flow (session status
            // AWAITING_DETAILS — we've already committed to an intent and are just collecting
            // the remaining fields), a stray follow-up like a bare phone number would get
            // freshly (mis)classified — e.g. "08168811821" alone read as a new VEND_DATA
            // request — and silently overwrite the REAL, already-in-progress intent (the
            // user's actual ELECTRICITY request), abandoning it entirely. Worse, the same
            // unconditional overwrite clobbered destination_account (the meter number already
            // given) with whatever number showed up in the new message, so the correct value
            // was gone and the field engine kept re-asking for it forever.
            //
            // Fix: once we're continuing an established flow, the AI's fresh parse may only
            // fill in fields that are STILL missing, and may never re-route the intent itself
            // — a genuine change of mind is handled by the CONTEXT PIVOT check above (and now
            // covers every "waiting for a reply" state, not just this one), which explicitly
            // resets the session first. If we get here with AWAITING_DETAILS still active,
            // the user is continuing, not switching.
            const continuingFlow = session?.status === 'AWAITING_DETAILS';

            intentData = {
                ...intentData,
                ...(!continuingFlow && mapped ? { intent: mapped } : {}),
                ...(aiParsed.amount_ngn && !intentData.amount_ngn ? { amount_ngn: aiParsed.amount_ngn } : {}),
                ...(aiParsed.destination_account && !intentData.destination_account ? { destination_account: aiParsed.destination_account } : {}),
                ...(aiParsed.provider && !intentData.provider ? { provider: aiParsed.provider } : {}),
                ...(aiParsed.meter_type && !intentData.meter_type ? { meter_type: aiParsed.meter_type } : {}),
                // ⚡ Scheduling context must survive multi-turn collection — "buy airtime in
                // the next 2 minutes" usually arrives MISSING the amount, and the follow-up
                // ("100") is parsed fresh with no memory of the request. Without persisting
                // these into intentData (and therefore into the saved session), the schedule
                // was silently forgotten by the time all fields arrived, and the payment
                // executed IMMEDIATELY instead — money moving at a time the user didn't ask
                // for. Stored as an absolute timestamp so "2 minutes" counts from when the
                // user SAID it, not from whenever the last field finally arrived.
                ...(aiParsed.is_recurring && !intentData.is_recurring ? { is_recurring: true, frequency: aiParsed.frequency, day_of_week: aiParsed.day_of_week, day_of_month: aiParsed.day_of_month } : {}),
                ...(aiParsed.schedule_in_minutes && aiParsed.schedule_in_minutes > 0 && !intentData.schedule_run_at ? { schedule_run_at: new Date(Date.now() + aiParsed.schedule_in_minutes * 60_000).toISOString() } : {}),
                // The AI extracts chain/token when the user names them ("on Celo", "with
                // USDC") — previously discarded here, so saying "Celo" was met with the same
                // question again. Persisting them means naming a chain/token at ANY point in
                // the conversation skips the corresponding selection prompt entirely.
                ...(aiParsed.chain && !intentData.chain ? { chain: aiParsed.chain } : {}),
                ...(aiParsed.token && !intentData.selected_token ? { selected_token: aiParsed.token } : {}),
                // Remember the user's language on the session so every later reply this
                // conversation (including short "1"/PIN turns) can be localized too.
                ...(aiParsed.language && aiParsed.language !== 'en' ? { language: aiParsed.language } : {}),
            };
        } catch (e) {
            // Ignore AI errors — the regex sweep below still catches the common cases.
        }

        // ⚡ GUARANTEED REGEX OVERRIDE: fills in anything the AI didn't already resolve
        // (extractEntities only ever sets a field when it's still falsy — never overwrites
        // an AI-sourced value).
        intentData = extractEntities(text, intentData);

        // ⚡ "Buy airtime to my WhatsApp number" / "recharge me" — WhatsApp's identity IS a
        // phone number (platform_id is the sender's own wa_id), unlike Telegram/X where it's
        // an opaque chat id. When no account was found anywhere above and the message reads
        // as self-referential, default the target to the sender's own number instead of
        // asking them to type back the number they're already messaging from.
        if (platform === 'WHATSAPP' && !intentData.destination_account && ['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent)) {
            // 🔴 THE GAP: only matched "my WhatsApp NUMBER" — a real user wrote "my WhatsApp
            // ACCOUNT" and fell straight through. Broadened to any of number/account/line, and
            // to a bare "my whatsapp" with nothing after it (WHATSAPP_SELF_REFERENCE_RE, shared
            // with guest mode below so both paths recognize exactly the same phrasing).
            const selfReference = WHATSAPP_SELF_REFERENCE_RE.test(text);
            if (selfReference) {
                // wa_id is E.164 without "+" (e.g. "2348168811821") — the network-prefix
                // detection below (extractEntities / the AI's own inference) expects the
                // local format Nigerians actually use ("08168811821").
                const waId = String(platform_id || '');
                const localNumber = waId.startsWith('234') && waId.length === 13 ? `0${waId.slice(3)}` : waId;
                intentData.destination_account = localNumber;
            }
        }
    }

    if (intentData?.intent === 'TRANSACTION_STATUS' || intentData?.intent === 'STATUS') intentData.intent = 'TRANSACTION_HISTORY';

    // ⚡ GUEST GATE — WALLET-ONLY INTENTS ⚡
    // Balance, history, and schedules are all keyed by a wallet_address the bot only knows
    // for a LINKED user (globalUser). Without this gate, CHECK_BALANCE/TRANSACTION_HISTORY
    // would silently return empty/meaningless results (globalUser?.wallet_address || "" —
    // defensively coded, but pointless for a guest), and TRANSACTION_HISTORY specifically
    // would CRASH — its query reads globalUser.wallet_address with no optional chaining at
    // all, since it was only ever reached after the old guest branch's hard early-return and
    // was never exercised without a linked identity. Redirect clearly instead of either.
    if (isGuest && ['CHECK_BALANCE', 'TRANSACTION_HISTORY', 'LIST_SCHEDULES', 'CANCEL_SCHEDULE'].includes(intentData.intent)) {
        return NextResponse.json({
            action: 'REPLY',
            message: `🔒 That needs a linked wallet — link yours once at https://abapays.com and you can check this right here, no PIN needed just to look.`,
        });
    }

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

        // 🔴 THE "can't send airtime to NI" BUG: the AI sometimes emits a stray/wrong country
        // code (e.g. "NI" for Nigeria instead of ISO "NG"), and the old check treated ANY
        // non-NG value on ANY intent as an international AIRTIME request — so "I need
        // electricity for my ibedc prepaid meter" got answered with "I can't send airtime to
        // NI", twice over wrong (wrong service, phantom country). Two guards:
        //   1. Normalize common Nigeria mis-codes to NG before comparing.
        //   2. Only airtime/data can be international — electricity/TV/bank/education are
        //      domestic-only services, so a country code on those intents is parser noise,
        //      never a reason to reroute the request.
        const NIGERIA_ALIASES = new Set(['NG', 'NI', 'NGA']);
        const normalizedCountry = aiParsed.country && NIGERIA_ALIASES.has(String(aiParsed.country).toUpperCase()) ? 'NG' : aiParsed.country;
        const canBeForeign = ['VEND_AIRTIME', 'VEND_DATA', 'INTERNATIONAL', 'UNKNOWN'].includes(aiParsed.intent);
        const isForeign = canBeForeign && normalizedCountry && normalizedCountry !== 'NG';
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
                country: normalizedCountry,
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
                // A bad AMOUNT is recoverable: the meter/provider/customer are already
                // verified and the user just needs to name a valid figure. Deleting the
                // session here was the bug behind "min amount ₦4837 → user says 'recharge
                // 5k' → bot silently restarts as VEND AIRTIME": with no session, the next
                // message got re-classified from scratch ("recharge" reads as airtime) and
                // the whole electricity context was lost. Keep the session in AWAITING_DETAILS,
                // clear ONLY the rejected amount, and let the next number continue this flow.
                const recoverable = f.blockCode === 'AMOUNT_TOO_LOW' || f.blockCode === 'AMOUNT_TOO_HIGH';
                if (recoverable) {
                    intentData.amount_ngn = null;
                    await supabase.from('deai_sessions').upsert({
                        chat_id: platform_id, platform, intent_data: intentData,
                        status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString(),
                    }, { onConflict: 'chat_id' });
                } else {
                    await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);
                }
                return NextResponse.json({
                    action: 'REPLY',
                    message: [`⚠️ ${f.reason}`, ``, ...f.suggestions.map(sug => `• ${sug}`)].join('\n'),
                });
            }
            // If details are missing, the existing state machine below collects them.
        }
    }

    // ⚡ 4b-bis. MULTI-RECIPIENT (BATCH) PAYMENTS ⚡
    //
    // 🔴 THE GAP THIS CLOSES: the intent engine has always emitted a fully-resolved
    // `recipients` array when a user names 2+ people in one message (rule 14) — and the in-app
    // chat (/api/deai/chat) has always handled it. This route, which serves Telegram/WhatsApp/X,
    // never read `recipients` at all. Because the engine deliberately leaves the SINGULAR
    // amount/account fields null in that case, the request didn't just lose the extra
    // recipients — it collapsed into "I just need the Target Number/Account and the Amount",
    // asking for details the user had already given, for two people. A real feature, silently
    // dead on every social channel.
    //
    // Runs BEFORE the automations/missing-field engine below, since those assume the singular
    // fields are populated.
    if (aiParsed?.recipients && aiParsed.recipients.length >= 2) {
        const batchIntent = intentData.intent;

        // A batch spends from a pre-approved on-chain allowance — there's no such thing for a
        // guest, and a deep link can only carry ONE payment, so there's nothing useful to hand
        // them. Say exactly that rather than failing vaguely.
        if (isGuest) {
            return NextResponse.json({
                action: 'REPLY',
                message: `👥 *Paying several people at once needs a linked wallet* (it spends from an approved agent limit).\n\nLink once at https://abapays.com — or send them to me one at a time and I'll give you a payment link for each.`,
            });
        }

        if (batchIntent !== 'VEND_AIRTIME' && batchIntent !== 'VEND_DATA') {
            return NextResponse.json({
                action: 'REPLY',
                message: `👥 Paying several people in one message works for *airtime* and *data* right now — please send other bills one at a time.`,
            });
        }

        // Validate EVERY recipient before proposing anything. All-or-nothing: a batch that's
        // half-valid is worse than a clear "fix this one and resend".
        const items: BatchItem[] = [];
        for (const rec of aiParsed.recipients) {
            // The number's own prefix is authoritative for the network, exactly as in the
            // single-payment path — never trust the model's guess over the prefix table.
            const detected = rec.destination_account ? detectNetwork(rec.destination_account) : null;
            const provider = detected || rec.provider;

            const feas = await assessFeasibility({
                intent: batchIntent, provider, amountNgn: rec.amount_ngn, account: rec.destination_account,
            });
            if (!feas.possible || feas.missing.length) {
                return NextResponse.json({
                    action: 'REPLY',
                    message: `⚠️ I can't send this batch yet — *${rec.destination_account || 'one recipient'}* has an issue:\n\n${feas.reason || 'missing details'}\n\nFix that one and send me the whole list again.`,
                });
            }
            items.push({
                serviceCategory: batchIntent === 'VEND_DATA' ? 'DATA' : 'AIRTIME',
                serviceID: resolveServiceId(batchIntent, provider || null) || provider || '',
                provider,
                billersCode: rec.destination_account as string,
                amountNgn: rec.amount_ngn as number,
                chain: (rec.chain || intentData.chain || globalUser?.approved_chain || 'CELO').toUpperCase(),
                tokenSymbol: rec.token || intentData.selected_token || globalUser?.approved_token || 'USD₮',
            });
        }

        const totalNgn = items.reduce((s, it) => s + it.amountNgn, 0);

        // Operator gate on the TOTAL — the per-tx cap alone would let a batch slip past the
        // daily cap by splitting it across recipients.
        const batchGate = await checkAgentSpendAllowed(supabase, globalUser?.wallet_address || '', totalNgn);
        if (!batchGate.allowed) {
            return NextResponse.json({ action: 'REPLY', message: `⚠️ ${batchGate.reason}` });
        }

        // Capacity per (chain, token) group against that group's own subtotal.
        const batchRate = await getExchangeRate();
        const groups = groupByChainToken(items);
        const groupLines: string[] = [];
        for (const [key, groupItems] of groups) {
            const [gChain, gToken] = key.split('|');
            const gTotal = groupItems.reduce((s, it) => s + it.amountNgn, 0);
            const capacity = await checkAutonomousCapacity(globalUser?.wallet_address || '', gChain, gToken, gTotal, batchRate);
            if (!capacity.ok) {
                return NextResponse.json({ action: 'REPLY', message: `⚠️ ${capacity.reason}` });
            }
            groupLines.push(`• *${gToken} on ${gChain}* — ${groupItems.length} payment${groupItems.length === 1 ? '' : 's'}, ₦${gTotal.toLocaleString()} (${capacity.neededCrypto.toFixed(4)} ${gToken})`);
        }

        // 🔒 PIN-GATED, exactly like a single payment — this moves real money for several
        // people at once, so it must never execute off a bare message.
        intentData.pending_batch = { items, totalNgn };
        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: intentData,
            status: 'AWAITING_PIN', expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        return NextResponse.json({
            action: 'REPLY',
            message: [
                `👥 *Confirm ${items.length} payments — ₦${totalNgn.toLocaleString()} total*`,
                ``,
                ...items.map((it, i) => `*${i + 1}.* ${(it.provider || '').toUpperCase()} ${it.serviceCategory === 'DATA' ? 'data' : 'airtime'} — ₦${it.amountNgn.toLocaleString()} → ${it.billersCode}`),
                ``,
                ...groupLines,
                ``,
                `🔒 Reply with your *PIN* to send all ${items.length}.`,
            ].join('\n'),
        });
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

            const ordinalDay = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
            const lines = (scheds as any[]).map((sc) => {
                // 🔴 "on the nullth monthly" bug: a one-off ('once') schedule has no
                // day_of_month, so the default branch rendered "nullth". Handle 'once'
                // explicitly with its run_once_at time.
                const when = sc.frequency === 'once'
                    ? (sc.run_once_at ? `once, at ${new Date(sc.run_once_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}` : 'once')
                    : sc.frequency === 'weekly'
                    ? `every ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][sc.day_of_week] || '?'}`
                    : sc.frequency === 'daily' ? 'daily'
                    : sc.day_of_month ? `on the ${ordinalDay(sc.day_of_month)} monthly` : 'monthly';
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

        // "every Tuesday buy 200 airtime for 08012345678"  (recurring)
        // "buy airtime for my number in the next 2 minutes" (one-off future)
        //
        // 🔴 THE BUG: schedule_in_minutes (the one-off case) was only ever wired into the
        // in-app web chat (/api/deai/chat) — this route, which serves Telegram/WhatsApp/X,
        // checked is_recurring alone. So "in the next 2 minutes" was silently DROPPED and
        // the payment executed immediately instead — technically a spend the user only
        // authorized for 2 minutes later, and a scheduling feature that looked broken.
        // Reads the PERSISTED intentData fields (see the merge block above), so a schedule
        // stated in the first message survives however many turns it takes to collect the
        // rest of the details.
        const isOneOffFuture = !!intentData.schedule_run_at;
        if ((intentData.is_recurring || aiParsed.is_recurring || isOneOffFuture) && ['VEND_AIRTIME', 'VEND_DATA', 'ELECTRICITY', 'TV'].includes(intentData.intent)) {
            // ⚡ GUEST GATE — a schedule is stored keyed by wallet_address (scheduled_bills)
            // and, if auto_execute, needs an on-chain allowance to actually run — neither
            // exists for a guest. Redirect to link a wallet rather than silently building a
            // schedule tied to no one (or, worse, reaching buildScheduleConfirm's own
            // AWAITING_PIN transition with no identity to verify against).
            if (isGuest) {
                return NextResponse.json({
                    action: 'REPLY',
                    message: `🔒 Automated/scheduled payments need a linked wallet (so I know where to check your balance and who to notify). Link yours once at https://abapays.com, then set this up again — or pay it right now instead and I'll send you a link.`,
                });
            }

            // Same prefix-is-authoritative rule as the MISSING FIELD ENGINE below (which runs
            // after this block) — override the AI's network guess with the number's own prefix
            // so a scheduled airtime never locks in the wrong network.
            if (['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent) && intentData.destination_account) {
                const detected = detectNetwork(intentData.destination_account);
                if (detected) { if (intentData.provider !== detected) intentData.provider_label = null; intentData.provider = detected; }
            }

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
                // Save the session INCLUDING the scheduling fields — without this, the reply
                // that supplies the missing amount/number arrived to a bot with no memory
                // that a schedule was ever requested.
                await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
                return NextResponse.json({ action: 'REPLY', message: [`🔁 Happy to set that up — ${f.reason}`, ``, ...f.suggestions.map(s2 => `• ${s2}`)].join('\n') });
            }

            // Resolve token/chain, run the balance/allowance checks, and either ask which
            // funded allowance to use (when the user named none and has more than one) or
            // stash the schedule for PIN confirmation. Extracted so the "which balance?"
            // reply can re-enter the exact same build — see buildScheduleConfirm.
            return await buildScheduleConfirm(
                intentData, globalUser?.wallet_address || '', platform, platform_id,
                globalUser?.approved_token, globalUser?.approved_chain,
            );
        }
    }

    // (EMERGENCY REVOKE moved to the escape-hatch block near the top, beside `cancel` — it was
    // unreachable here whenever a PIN was pending. See the comment there.)

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

      // 🔴 THE BUG THIS FIXES: `wantsSupport` matches the RAW message text only, so ordinary
      // phrasings that merely START with one of these words hijacked a real request and wiped
      // it (`intent_data: {}` below discards everything collected so far):
      //   "Help me send 500 airtime to 08012345678"  -> ^help me\b   -> support ticket
      //   "Agent, buy 500 airtime for 08012345678"   -> ^agent\b     -> support ticket
      //   "Contact: 08012345678" (answering a prompt) -> ^contact\b  -> wipes the payment
      // Now it only fires when the message ISN'T a usable service request: if the AI resolved a
      // real payable intent, or we're mid-collection with details already gathered, treat it as
      // part of that flow. A genuine "support" / "talk to a human" carries no payable intent
      // and so still routes here exactly as before.
      const hasRealIntent = !!intentData?.intent && intentData.intent !== 'UNKNOWN' && !!SERVICE_RULES[intentData.intent];
      const midCollection = session?.status === 'AWAITING_DETAILS' &&
        !!(session.intent_data?.amount_ngn || session.intent_data?.destination_account);

      if (wantsSupport && !hasRealIntent && !midCollection) {
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
        // ⚡ A plain greeting isn't a failed request — it's not a request at all. Dumping the
        // entire capability menu in response to "Hey" reads as robotic and overwhelming for
        // what should be a one-line reply. Full menu is still one message away — HELP/"what
        // can you do" already returns describeCapabilities().
        if (GREETING_RE.test(text.trim())) {
            return NextResponse.json({
                action: 'REPLY',
                message: `👋 Hey! What can I help you with — airtime, data, a bill, or your balance?`,
            });
        }

        // ⚡ Same for a simple courtesy ("thanks", "ok", "nice"). Guest mode already answers
        // these warmly in one line, but a LINKED user — an actual paying customer — had no
        // equivalent path and fell through to the full multi-paragraph capability dump for
        // saying "thanks", making the bot read as friendlier to strangers than to people it
        // knows. Mirrors the guest handler's wording and its <25-char guard (so "thanks, but
        // the meter number was wrong" is still treated as a real message, not a sign-off).
        const courtesy = text.trim().toLowerCase();
        if (courtesy.length < 25 && /(thank|thanks|thank you|ok|okay|cool|nice|great|👍|alright)/i.test(courtesy)) {
            return NextResponse.json({
                action: 'REPLY',
                message: `You're welcome! 🙌 Whenever you're ready to pay a bill, just tell me what you need.`,
            });
        }

        // ⚡ SMART GUESS — before falling back to the full capability dump, see if the crude
        // keyword matcher (freshIntentCheck) spotted a plausible service the AI itself didn't
        // commit to. A genuinely ambiguous message ("subscribe my TV", "recharge") deserves a
        // direct, actionable question — "did you mean X?" — not a wall of every capability
        // the bot has, most of which are irrelevant to what was actually typed.
        if (freshIntentCheck !== 'UNKNOWN' && INTENT_GUESS_LABELS[freshIntentCheck]) {
            return NextResponse.json({
                action: 'REPLY',
                message: `🤔 Did you mean you'd like to ${INTENT_GUESS_LABELS[freshIntentCheck]}? Tell me the amount and the account/number, and I'll take it from there.`,
            });
        }

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
        // ⚡ "what's my balance in my currency / in naira" — express the stablecoin holdings
        // as their local-currency (NGN) equivalent at the live rate, instead of only showing
        // raw token amounts. Since stablecoins are ~$1, total tokens × the USD→NGN rate is a
        // close, useful figure for a user who thinks in Naira.
        const wantsLocal = /\b(in|my)\s+(naira|ngn|currency|local)\b|in my currency|worth|value/i.test(text);
        if (wantsLocal) {
            const rate = await getExchangeRate();
            let totalTokens = 0;
            for (const chainBals of [crypto.celo, crypto.base]) {
                for (const v of Object.values(chainBals || {})) totalTokens += Number(v) || 0;
            }
            const ngnValue = totalTokens * rate;
            return NextResponse.json({
                action: 'REPLY',
                message: `💰 *Your Balance (in ${currencySymbol})*\n\n≈ *${currencySymbol}${ngnValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}* total\n\n🪙 Breakdown (value in ${currencySymbol}):\n${formatChainBalancesInFiat(crypto, rate, currencySymbol)}\n\n_At ${currencySymbol}${rate.toLocaleString()}/$._`,
            });
        }
        return NextResponse.json({
            action: 'REPLY',
            message: `💰 *Your Balance*\n\n🌍 Region: ${currentCountry}\n💵 Fiat: ${currencySymbol}${fiatBalance}\n🪙 Crypto:\n${formatChainBalances(crypto)}\n\n_Tip: ask "what's my balance in naira" to see the value in ${currencySymbol}._`,
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
    // 🔴 THE "wrong network" BUG: the AI infers a network from the phone number too, and that
    // guess merged in FIRST — so when the AI guessed wrong (e.g. Glo for an MTN number), the
    // old `!intentData.provider` guard meant this deterministic prefix lookup never got to
    // correct it. The MAIN APP has no AI: it derives the network purely from the number's
    // prefix and is therefore always right. Match it exactly — for airtime/data, the prefix
    // is authoritative and OVERRIDES the AI's guess whenever we can resolve it. Only when the
    // prefix is unknown do we keep whatever the AI/earlier turns provided.
    if (['VEND_AIRTIME', 'VEND_DATA'].includes(intentData.intent) && intentData.destination_account) {
        const detected = detectNetwork(intentData.destination_account);
        if (detected) {
            if (intentData.provider && intentData.provider !== detected) {
                // The AI (or a stale value) disagreed with the number's own prefix — trust the
                // prefix, and drop any label tied to the wrong guess.
                intentData.provider_label = null;
            }
            intentData.provider = detected;
        }
    }

    // 🔴 THE "PRODUCT DOES NOT EXIST" BUG: the AI infers a phone network from ANY number in
    // the message (it's told to), including the CONTACT phone on an electricity request. So
    // "buy electric for my meter ... 08168811821" came back with provider "MTN" — a telecom
    // network, never a valid electricity disco or cable provider. That wrong value then
    // bypassed the disco picker below (which only fires when provider is empty), and the
    // request failed at VTpass ("PRODUCT DOES NOT EXIST") trying to verify a meter against a
    // phone-network serviceID. Validate the provider against the ACTUAL option list for this
    // intent; if it doesn't match (a telecom on ELECTRICITY/TV), drop it so the picker fires.
    // Moved here (was further below) so the CABLE FAST PATH right after it never mistakes a
    // bogus telecom-network guess for a real, already-known cable provider.
    if (intentData.provider && ['ELECTRICITY', 'TV'].includes(intentData.intent)) {
        const spec = providersFor(intentData.intent);
        if (spec && !matchProvider(String(intentData.provider), spec.options)) {
            intentData.provider = null;
            intentData.provider_label = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ⚡ CABLE FAST PATH (TV) ⚡
    // ═══════════════════════════════════════════════════════════════════════
    //
    // 🔴 THE FULL BUG THIS REDESIGNS (from a real transcript): a user saying "Cable" was
    // asked for Amount + Target Number/Account + Contact Phone + Email ALL AT ONCE — before
    // even naming a provider. The provider question came LAST, only after all four fields
    // were collected. Verification of the smartcard/IUC number didn't happen until AFTER the
    // user had already picked a package from a flat, unpaginated 40-item list — so a mistyped
    // number wasted the whole conversation before failing.
    //
    // New order, matching how a human would actually ask: provider first -> account number ->
    // verify IMMEDIATELY -> package list (with the CURRENT package pinned as "Renew", price
    // included, via buildCablePackageOptions) -> chain/token (existing flow) -> phone/email
    // (existing REQ system, now fixed to never re-ask for a phone already given — see
    // REQ.phone's field rename in parity.ts).
    //
    // This block ONLY ever intercepts TV; every other intent falls through to the unchanged
    // generic SERVICE_RULES/PROVIDER/VARIATION machinery immediately below.
    if (intentData.intent === 'TV') {
        // 1. Provider first — reuses the existing generic AWAITING_PROVIDER status/handler
        // (see providersFor/matchProvider), so this needs no new state-handling code.
        if (!intentData.provider) {
            const spec = providersFor('TV')!;
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

        // 2. Account number next — asked ALONE, not bundled with amount/phone/email.
        if (!intentData.destination_account) {
            await supabase.from('deai_sessions').upsert({
                chat_id: platform_id, platform, intent_data: intentData,
                status: 'AWAITING_DETAILS',
                expires_at: new Date(Date.now() + 300000).toISOString(),
            }, { onConflict: 'chat_id' });
            return NextResponse.json({
                action: 'REPLY',
                message: `${prependSystemMsg}📺 *${(intentData.provider_label || intentData.provider).toUpperCase()}*\n\nWhat's the smartcard/IUC number?`,
            });
        }

        // 3. Verify IMMEDIATELY — before any package is ever offered, not after.
        if (!intentData.verified_name) {
            const acctCheck = checkAccountNumber(intentData.intent, intentData.destination_account, intentData.provider);
            if (!acctCheck.valid) {
                intentData.destination_account = null;
                await supabase.from('deai_sessions').upsert({
                    chat_id: platform_id, platform, intent_data: intentData,
                    status: 'AWAITING_DETAILS',
                    expires_at: new Date(Date.now() + 300000).toISOString(),
                }, { onConflict: 'chat_id' });
                return NextResponse.json({ action: 'REPLY', message: `⚠️ ${acctCheck.error}\n\nPlease reply with the correct smartcard/IUC number.` });
            }

            const verification = await verifyAccount(intentData.intent, intentData.destination_account, undefined, intentData.provider);
            if (!verification.success) {
                intentData.destination_account = null;
                await supabase.from('deai_sessions').upsert({
                    chat_id: platform_id, platform, intent_data: intentData,
                    status: 'AWAITING_DETAILS',
                    expires_at: new Date(Date.now() + 300000).toISOString(),
                }, { onConflict: 'chat_id' });
                return NextResponse.json({
                    action: 'REPLY',
                    message: `❌ ${verification.message || "That smartcard/IUC number couldn't be verified"} for *${intentData.provider_label || intentData.provider}*.\n\nPlease reply with the correct number.`,
                });
            }

            intentData.verified_name = verification.customer_name;
            intentData.customer_name = verification.customer_name;
            if (verification.min_amount) intentData.verified_min = verification.min_amount;
            // The fields that let the package list pin "Renew: <bouquet>" below — see
            // VerifiedAccount's comment in services.ts for how these were confirmed real.
            intentData.cable_current_bouquet = verification.current_bouquet || null;
            intentData.cable_renewal_amount = verification.renewal_amount || null;

            prependSystemMsg += `✅ *Verified*\n👤 ${verification.customer_name}\n\n`;
        }
        // Falls through from here into the (now cable_renewal_amount-aware) generic
        // SERVICE_RULES / VARIATION GATE machinery below — provider, destination_account,
        // and verified_name are all already set, so those gates simply pass through to the
        // package list / renew pin.
    }

    const rules = SERVICE_RULES[intentData.intent];
    if (rules) {
        let missing = [];
        
        for (const field of rules.required) {
            if (!intentData[field]) {
                if (field === 'amount_ngn') missing.push("the *Amount*");
                if (field === 'destination_account') missing.push("the *Target Number/Account*");
                if (field === 'provider') missing.push("the *Network Provider*");
                if (field === 'phone') missing.push("your *Contact Phone Number*");
                if (field === 'email') missing.push("your *Email Address*");
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

            // ⚡ CLARIFYING-QUESTION DETECTION — "Did you mean the meter number?" is a question
            // ABOUT what we're asking, not an attempt to answer it. Repeating the exact same
            // generic prompt back reads as not having understood the question at all. When
            // there's exactly one missing field and the reply looks like a question, confirm
            // directly instead.
            const looksLikeQuestion = /\?\s*$/.test(text.trim()) || /\b(did you mean|do you mean|you mean|is it)\b/i.test(text);
            if (looksLikeQuestion && missing.length === 1) {
                const fieldLabel = missing[0].replace(/\*/g, '');
                return NextResponse.json({
                    action: 'REPLY',
                    message: `${prependSystemMsg}Yes — please reply with ${fieldLabel} to continue your ${intentData.intent.replace('_', ' ').toLowerCase()} request.`,
                });
            }

            return NextResponse.json({ action: 'REPLY', message: `${prependSystemMsg}${echoMsg}To complete your ${intentData.intent.replace('_', ' ')}, please reply with ${missing.join(", ")}.` });
        }

        // A picked variation or a verified cable renewal is a FIXED, already-correct price —
        // same reasoning as the later AMOUNT LIMITS gate's isFixedPlan check — so it's exempt
        // from the generic per-service minimum here too.
        const isFixedAmount = !!intentData.variation_code || intentData.cable_action === 'renew';
        const activeMin = intentData.verified_min || rules.min;
        if (!isFixedAmount && activeMin && intentData.amount_ngn && intentData.amount_ngn < activeMin) {
            intentData.amount_ngn = null; 
            await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
            return NextResponse.json({ action: 'REPLY', message: `❌ Minimum amount for this service is ${currencySymbol}${activeMin}. Please reply with a valid amount.` });
        }
    }

    // ⚡ THE OLD "DATA VARIATIONS GATE" USED TO LIVE HERE.
    //
    // It dumped every plan VTpass returned (MTN alone: ~50) as one flat numbered wall of
    // text, instead of the category-grouped menu (Daily/Weekly/Monthly/...) the web app
    // shows. Worse: it ran unconditionally BEFORE the correct, already-built replacement
    // below (`requiresVariation` + fetchVariations + groupDataPlans + AWAITING_PLAN_CATEGORY /
    // AWAITING_VARIATION) ever got a chance to run — that properly-grouped flow was fully
    // implemented and imported, but permanently shadowed as dead code by this block returning
    // first. Deleting this is the fix: VEND_DATA now falls through to the real implementation.

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
    // ⚡ CABLE: RENEW vs CHANGE (DStv/GOtv) — FALLBACK ONLY ⚡
    // The frontend lets DStv/GOtv users RENEW their current package (no plan needed) or
    // CHANGE to a new one (plan required). This explicit question is now a FALLBACK: the
    // normal path pins "Renew: <bouquet>" directly atop the package list (see
    // buildCablePackageOptions, wired in below) using the real bouquet name + price VTpass's
    // merchant-verify returns — so the user never has to answer this generic question at all
    // in the common case. This still fires only when that pinned option genuinely isn't
    // available (verify didn't return a renewal amount this time), so renewals keep working.
    if (intentData.intent === 'TV' && supportsRenew(intentData.provider) && !intentData.cable_action && !(Number(intentData.cable_renewal_amount) > 0)) {
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

    if (requiresVariation(intentData.intent, intentData.provider, intentData.cable_action) && !intentData.variation_code && !(intentData.cable_action === 'renew' && intentData.amount_ngn)) {
        const serviceID = variationServiceId(intentData.intent, intentData.provider);
        const rawOptions = await fetchVariations(serviceID);

        if (rawOptions.length === 0) {
            return NextResponse.json({
                action: 'REPLY',
                message: `⚠️ I couldn't load the plans for ${intentData.provider_label || intentData.provider} right now. Please try again shortly, or pay in the app.`,
            });
        }

        // Pin "Renew: <bouquet>" atop the list when we have a real bouquet + renewal amount
        // for this smartcard (TV/DStv/GOtv only — see buildCablePackageOptions).
        const cablePinned = intentData.intent === 'TV'
            ? buildCablePackageOptions(rawOptions, intentData.provider, intentData.cable_current_bouquet, intentData.cable_renewal_amount)
            : null;
        const options = cablePinned || rawOptions;

        // ⚡ DATA: GROUP BY CATEGORY (frontend parity).
        //
        // MTN alone returns ~50 plans. A flat numbered list is a wall of text in a chat
        // window. The web app groups them into tabs (Daily, Weekly, Monthly, SME,
        // Broadband…) — the agent uses the SAME categorizeDataPlan() function, so the two
        // can never group differently.
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

            // Category already chosen — list the plans inside it, PAGINATED (some
            // categories run 30+ plans deep for a busy network).
            const group = groups.find(g => g.category === intentData.plan_category);
            const plans = group?.plans || options;
            const rendered = renderOptionsPage(plans, 0, { showPrice: true });

            await supabase.from('deai_sessions').upsert({
                chat_id: platform_id, platform, intent_data: { ...intentData, variation_page: 0 },
                status: 'AWAITING_VARIATION',
                expires_at: new Date(Date.now() + 300000).toISOString(),
            }, { onConflict: 'chat_id' });

            const footer = rendered.hasMore
                ? `\n\n_Page 1/${rendered.totalPages} — reply *next* to see more, or reply with the number._`
                : `\n\n_Reply with the number._`;
            return NextResponse.json({
                action: 'REPLY',
                message: `${prependSystemMsg}📦 *${intentData.plan_category} plans:*\n\n${rendered.text}${footer}`,
            });
        }

        // ⚡ CABLE / EDUCATION — PAGINATED (DStv alone runs ~40 packages; was one flat wall
        // of numbered text before). Groups of VARIATION_PAGE_SIZE, "next" to see more.
        const rendered = renderOptionsPage(options, 0, { showPrice: true });

        await supabase.from('deai_sessions').upsert({
            chat_id: platform_id, platform, intent_data: { ...intentData, variation_page: 0 },
            status: 'AWAITING_VARIATION',
            expires_at: new Date(Date.now() + 300000).toISOString(),
        }, { onConflict: 'chat_id' });

        const title = intentData.intent === 'TV' ? '📺 *Choose a package:*'
                    : intentData.intent === 'EDUCATION' ? '🎓 *Choose a product:*'
                    : '📦 *Choose a plan:*';
        const footer = rendered.hasMore
            ? `\n\n_Page 1/${rendered.totalPages} — reply *next* to see more, or reply with the number._`
            : `\n\n_Reply with the number._`;

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}${title}\n\n${rendered.text}${footer}`,
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
    // data bundle for being "below the ₦100 minimum". A cable RENEWAL is the same kind of
    // fixed, non-negotiable price — it's VTpass's own verified renewal_amount, not a number
    // the user chose — so it must skip min/max too, exactly like a variation pick.
    if (intentData.amount_ngn) {
        const isFixedPlan = !!intentData.variation_code || intentData.cable_action === 'renew';
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

    // ⚡ ELECTRICITY VERIFICATION — runs whenever meter_type + provider are known, regardless
    // of WHERE meter_type came from.
    //
    // 🔴 THE BUG THIS FIXES: verifyAccount() only ever ran inside the AWAITING_METER_TYPE
    // handler above (i.e. only when the user was ASKED prepaid/postpaid and replied). A user
    // who stated it upfront ("my prepaid meter 14533083334") skipped that handler entirely —
    // meter_type was already set, so the gate above never fired — meaning verification was
    // NEVER ATTEMPTED AT ALL. The unverified meter number then sailed straight through
    // provider, chain, and token selection, only to fail much later at the parity check with
    // a generic "I couldn't verify that account" — giving no indication of which account,
    // which provider, or that the whole electricity flow (not some unrelated data purchase)
    // was what actually failed.
    if (intentData.intent === 'ELECTRICITY' && intentData.meter_type && intentData.provider && !intentData.verified_name) {
        const verification = await verifyAccount(intentData.intent, intentData.destination_account, intentData.meter_type, intentData.provider);

        if (!verification.success) {
            // Keep everything ELSE (provider, meter_type, phone, email) so the user only has
            // to send a corrected meter number, not restart the whole request from scratch.
            intentData.destination_account = null;
            await supabase.from('deai_sessions').upsert({ chat_id: platform_id, platform, intent_data: intentData, status: 'AWAITING_DETAILS', expires_at: new Date(Date.now() + 300000).toISOString() }, { onConflict: 'chat_id' });
            return NextResponse.json({
                action: 'REPLY',
                message: `❌ ${verification.message || "That meter number couldn't be verified"} for *${intentData.provider_label || intentData.provider}*.\n\nPlease reply with the correct meter number.`,
            });
        }

        intentData.verified_name = verification.customer_name;
        intentData.customer_name = verification.customer_name;
        intentData.customer_address = verification.customer_address;
        if (verification.min_amount) intentData.verified_min = verification.min_amount;
        prependSystemMsg += `✅ *Meter Verified!*\nName: ${verification.customer_name}\n${verification.customer_address ? `Address: ${verification.customer_address}\n` : ''}\n`;
    }

    // ⚡ GUEST FORK — everything SERVICE-level above (provider resolution, electricity/meter
    // verification, feasibility) just ran identically for a guest as it would for a linked
    // user, because it's the same code. Chain/token selection is where the two flows
    // genuinely diverge: it means "which on-chain ALLOWANCE should the agent spend from" — a
    // concept that doesn't exist without a linked wallet. So instead of asking, a guest goes
    // straight to the same signed deep-link hand-off a LINKED user with no allowance already
    // gets ("Path B" in the AWAITING_PIN handler above) — built from the exact same collected,
    // verified data. This is the ONE place "generate a link instead of asking for a PIN" (the
    // final-execution step) actually happens for a guest.
    if (isGuest) {
        const category = intentData.intent === 'ELECTRICITY' ? 'ELECTRICITY'
                        : intentData.intent === 'TV' ? 'CABLE'
                        : intentData.intent === 'VEND_DATA' ? 'DATA' : 'AIRTIME';
        const serviceID = resolveServiceId(intentData.intent, intentData.provider || null) || intentData.provider || '';
        const guestHost = req.headers.get('host');
        const guestProto = guestHost?.includes('localhost') ? 'http' : 'https';
        const guestBaseUrl = `${guestProto}://${guestHost}`;
        const serviceLabel = intentData.intent === 'ELECTRICITY' ? 'Electricity'
                            : intentData.intent === 'VEND_DATA' ? 'Data'
                            : intentData.intent === 'TV' ? 'Cable' : 'Airtime';

        await supabase.from('deai_sessions').delete().eq('chat_id', platform_id);

        try {
            const payUrl = createDeepLink(guestBaseUrl, {
                serviceID,
                serviceCategory: category,
                provider: intentData.provider || '',
                billersCode: intentData.destination_account,
                amountNgn: Number(intentData.amount_ngn),
                variationCode: intentData.variation_code || undefined,
                meterType: intentData.meter_type || undefined,
                cableAction: intentData.cable_action || undefined,
                customerName: intentData.customer_name || undefined,
                customerAddress: intentData.customer_address || undefined,
                channel: platform,
                chatId: platform_id,
            });

            return NextResponse.json({
                action: 'REPLY',
                message: [
                    `${prependSystemMsg}✅ *Ready to pay*`,
                    ``,
                    `*${intentData.provider || ''} ${serviceLabel}*`,
                    intentData.customer_name ? `👤 ${intentData.customer_name}` : null,
                    `📱 ${intentData.destination_account}`,
                    `💰 ₦${Number(intentData.amount_ngn).toLocaleString()}`,
                    ``,
                    payLink('Tap here to pay in your web3 browser', payUrl, platform),
                    ``,
                    `_You'll connect and sign with your own wallet — AbaPay never holds your funds. Link expires in 15 minutes._`,
                    ``,
                    `_Tip: link your wallet once at https://abapays.com and you can pay right here with just a PIN, no link needed._`,
                ].filter(Boolean).join('\n'),
            });
        } catch (linkErr) {
            console.error('[DeAI] Failed to build guest payment link:', linkErr);
            return NextResponse.json({ action: 'REPLY', message: "⚠️ I couldn't generate your payment link. Please try again, or pay directly at https://abapays.com" });
        }
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
        const list = await renderTokenChoicesWithAllowance(globalUser?.wallet_address || "", chosenChain);

        return NextResponse.json({
            action: 'REPLY',
            message: `${prependSystemMsg}⛓️ *${chosenChain}*\n\n💰 *Which token?*\n\n${list}\n\n_Reply with the number._`,
        });
    }

    // Fallback — every real flow above returns; this only guards the (unreachable in practice)
    // case where all fields are already set but no branch claimed the turn.
    return NextResponse.json({ action: 'REPLY', message: "🤔 I didn't catch that — say *help* to see what I can do." });

  } catch (error) {
    console.error("System Error:", error);
    return NextResponse.json({ action: 'REPLY', message: "🚨 System processing error. Please try again." });
  }
}
