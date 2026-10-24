'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { init, getHostNetwork, type NimiqProvider } from '@nimiq/mini-app-sdk';
import { Phone, Wifi, Lightbulb, Tv, GraduationCap, Landmark, Globe2, Loader2, CheckCircle2, XCircle, ExternalLink, Copy, Check, ChevronLeft, ChevronDown, Search, X, Home, History as HistoryIcon, Clock, Send, ShieldCheck, LogOut, Wallet } from 'lucide-react';
import { billCharges } from '@/lib/billCharges';

// ⚡ THE NIMIQ PAY MINI APP — every service abapays.com sells, paid in NIM.
//
// Flow, all against the NIM rail (src/app/api/pay/nim/route.ts):
//   1. the bill is described exactly as the main app describes it (same serviceID, category,
//      network, variation and customer fields), so the vend pipeline can't tell the difference;
//   2. POST { intent: true } → the server prices it in NIM and returns the treasury, the luna owed
//      and a reference;
//   3. Nimiq Pay sends the NIM with the reference as the payment's PLAIN-TEXT message (the host
//      stores it as UTF-8 recipient data; a basic transaction carries at most 64 bytes);
//   4. POST { intent_id, tx_hash } until the server has checked the payment on chain and vended.
//      Nimiq Pay doesn't always return a usable hash, so the server can also find the payment by
//      its reference.

type Svc = 'AIRTIME' | 'DATA' | 'ELECTRICITY' | 'CABLE' | 'EDUCATION' | 'BANK' | 'INTL';
type Provider = { serviceID: string; displayName: string; logo?: string; minAmount?: number; maxAmount?: number };
type Plan = { variation_code: string; name: string; variation_amount: string };
type Quote = {
  available: boolean; nim_usd: number | null; ngn_per_usd: number; buffer: number;
  /** Per tile, from the same gate abapays.com uses (kill switches, provider breaker). */
  services?: Record<string, { available: boolean; reason?: string }>;
};
type Intent = { intent_id: string; recipient: string; luna: number; nim: number; reference: string };
type Phase = 'idle' | 'ordering' | 'signing' | 'confirming' | 'done' | 'failed';

// Same icon colours as the main app's service tiles (src/constants SERVICES).
const SERVICES: { id: Svc; label: string; icon: typeof Phone; color: string; bg: string; category?: string }[] = [
  { id: 'AIRTIME', label: 'Airtime', icon: Phone, color: 'text-[#34d399]', bg: 'bg-emerald-500/10', category: 'airtime' },
  { id: 'DATA', label: 'Data', icon: Wifi, color: 'text-[#0ea5e9]', bg: 'bg-sky-500/10', category: 'data' },
  { id: 'ELECTRICITY', label: 'Electricity', icon: Lightbulb, color: 'text-[#f97316]', bg: 'bg-orange-500/10', category: 'electricity-bill' },
  { id: 'CABLE', label: 'Cable TV', icon: Tv, color: 'text-[#ec4899]', bg: 'bg-pink-500/10', category: 'tv-subscription' },
  { id: 'EDUCATION', label: 'Exam PINs', icon: GraduationCap, color: 'text-[#a855f7]', bg: 'bg-purple-500/10', category: 'education' },
  { id: 'BANK', label: 'Bank transfer', icon: Landmark, color: 'text-[#E9B213]', bg: 'bg-amber-500/10' },
  { id: 'INTL', label: 'International', icon: Globe2, color: 'text-[#6366f1]', bg: 'bg-indigo-500/10' },
];

/** A stored service_category → the tile it came from (international rows are "INTL …"). */
const CATEGORY_OF: Record<string, Svc> = { AIRTIME: 'AIRTIME', INTERNET: 'DATA', DATA: 'DATA', ELECTRICITY: 'ELECTRICITY', CABLE: 'CABLE', EDUCATION: 'EDUCATION', BANK: 'BANK' };

const LUNA = 100_000;
const AIRTIME_PRESETS = [200, 500, 1000, 2000, 5000];
const ELEC_PRESETS = [2000, 5000, 10000, 20000];
const OPEN_IN_NIMIQ_PAY = 'https://nimpay.app/miniapps/open/nim.abapays.com';

const ngn = (v: number) => `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const nimFmt = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} NIM`;
// A wallet balance keeps its decimals: rounded to whole NIM, anything under 0.5 NIM read as "0 NIM".
const nimBalanceFmt = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} NIM`;
// NIM is priced in USD (CoinGecko); NIM amounts are shown with their USD value, like abapays.com
// shows stablecoins. Naira stays for Nigerian bills, the destination currency for international ones.
const usdFmt = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 4 : 2 })}`;
// Set when the user taps Disconnect, so the app doesn't ask Nimiq Pay for the account again on
// the next open; cleared by Connect wallet. A per-device preference, so localStorage.
const DISCONNECTED_KEY = 'abapay_nim_disconnected';
const isPhone = (p: string) => /^0[789][01]\d{8}$/.test(p.replace(/\s+/g, ''));

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  return res.json() as Promise<T>;
}

/** Nimiq Pay answers some calls with { error } instead of throwing; this makes both a throw. */
function unwrap<T>(v: T | { error: { message?: string; type?: string } }): T {
  if (v && typeof v === 'object' && 'error' in (v as object)) {
    const e = (v as { error: { message?: string; type?: string } }).error;
    throw new Error(e?.message || e?.type || 'Nimiq Pay refused the request.');
  }
  return v as T;
}

export default function NimApp() {
  // ── Wallet ─────────────────────────────────────────────────────────────────────────────────
  const nimiq = useRef<NimiqProvider | null>(null);
  // The same provider as state, for children that render with it (a ref can't be read during render).
  const [wallet, setWallet] = useState<NimiqProvider | null>(null);
  // 'outside' = not running in Nimiq Pay at all. 'disconnected' = inside Nimiq Pay, but the user
  // declined the account prompt or tapped Disconnect: they get a Connect button, not a dead end.
  const [env, setEnv] = useState<'loading' | 'ready' | 'disconnected' | 'outside'>('loading');
  const [account, setAccount] = useState('');
  const [balanceLuna, setBalanceLuna] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [addrCopied, setAddrCopied] = useState(false);
  // The Nimiq network Nimiq Pay is on. Balances and payments are read on that network, so a host
  // on testnet shows 0 NIM against our mainnet service — said plainly instead of a silent zero.
  const [hostNetwork, setHostNetwork] = useState<string | undefined>(undefined);

  // 🔴 THE "0 NIM" BALANCE: getBalance read once, the instant the app opened, can come back 0
  // before Nimiq Pay has caught up with the network. Wait for consensus first (up to ~12s), and
  // keep the figure fresh (below) rather than trusting the first read forever.
  const refreshBalance = useCallback(async (addr: string) => {
    const p = nimiq.current;
    if (!p || !addr) return;
    // 🔴 THE CHAIN IS THE SOURCE OF TRUTH. Nimiq Pay's getBalance still answered 0 for funded
    // wallets after the consensus wait below (2026-10-17), so the balance is read from the Nimiq
    // chain by our server — the same read Pay uses — and the host's figure is only the fallback
    // for when the chain can't be reached.
    try {
      const r = await getJson<{ balance_luna: number | null }>(`/api/pay/nim/balance?address=${encodeURIComponent(addr)}`);
      if (typeof r?.balance_luna === 'number') { setBalanceLuna(r.balance_luna); return; }
    } catch { /* fall back to the host below */ }
    try {
      const hasConsensusCheck = typeof (p as { isConsensusEstablished?: unknown }).isConsensusEstablished === 'function';
      for (let i = 0; hasConsensusCheck && i < 12; i++) {
        const ok = await (p as unknown as { isConsensusEstablished(): Promise<boolean | { error: unknown }> }).isConsensusEstablished().catch(() => true);
        if (ok === true) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      const b = unwrap(await p.getBalance(addr));
      setBalanceLuna(Number(b));
    } catch { setBalanceLuna(null); }
  }, []);

  /** Ask Nimiq Pay for the account. Prompts the user; a decline leaves a Connect button. */
  const connect = useCallback(async () => {
    const p = nimiq.current;
    if (!p) return;
    setConnecting(true); setConnectError('');
    try {
      const accounts = unwrap(await p.listAccounts());
      if (!accounts?.length) throw new Error('No Nimiq account');
      try { localStorage.removeItem(DISCONNECTED_KEY); } catch { /* storage unavailable */ }
      setAccount(accounts[0]);
      setEnv('ready');
      refreshBalance(accounts[0]);
    } catch (e) {
      setEnv('disconnected');
      setConnectError(e instanceof Error && /reject|denied|declin|cancel/i.test(e.message) ? '' : 'Nimiq Pay didn’t share an account. Please try again.');
    } finally {
      setConnecting(false);
    }
  }, [refreshBalance]);

  /** Forget the account in this app. Nimiq Pay keeps its own permission; Connect asks again. */
  const disconnect = useCallback(() => {
    try { localStorage.setItem(DISCONNECTED_KEY, '1'); } catch { /* storage unavailable */ }
    try { sessionStorage.removeItem('abapay-nim-history-session'); } catch { /* storage unavailable */ } // HistoryView's SESSION_KEY
    setAccount(''); setBalanceLuna(null); setEnv('disconnected');
  }, []);

  useEffect(() => {
    let cancelled = false;
    init({ timeout: 8_000 })
      .then((p) => {
        if (cancelled) return;
        nimiq.current = p;
        setWallet(p);
        try { setHostNetwork(getHostNetwork()); } catch { /* older Nimiq Pay */ }
        let wasDisconnected = false;
        try { wasDisconnected = localStorage.getItem(DISCONNECTED_KEY) === '1'; } catch { /* storage unavailable */ }
        if (wasDisconnected) setEnv('disconnected');
        else void connect();
      })
      .catch(() => { if (!cancelled) setEnv('outside'); });
    return () => { cancelled = true; };
  }, [connect]);

  // Keep the balance current: every 20s while the app is open, and on returning to it.
  useEffect(() => {
    if (env !== 'ready' || !account) return;
    const t = setInterval(() => refreshBalance(account), 20_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshBalance(account); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [env, account, refreshBalance]);

  // ── Price ──────────────────────────────────────────────────────────────────────────────────
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    const load = () => getJson<Quote>('/api/pay/nim').then(setQuote).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // ── Service + form ─────────────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<'pay' | 'history'>('pay');
  const [svc, setSvc] = useState<Svc | null>(null);

  // serviceID → VTpass logo for every category, so History can show each order's provider logo.
  const [logos, setLogos] = useState<Record<string, string>>({});
  useEffect(() => {
    if (env !== 'ready') return;
    const cats = SERVICES.map((s) => s.category).filter(Boolean) as string[];
    Promise.all(cats.map((c) => getJson<{ providers?: Provider[] }>(`/api/providers?category=${c}`).catch(() => ({ providers: [] as Provider[] }))))
      .then((all) => setLogos(Object.fromEntries(all.flatMap((d) => (d.providers || []).filter((p) => p.logo).map((p) => [p.serviceID, p.logo as string])))))
      .catch(() => {});
  }, [env]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [account_, setAccountNumber] = useState(''); // meter / smartcard / bank account
  const [amount, setAmount] = useState('');
  const [meterType, setMeterType] = useState<'prepaid' | 'postpaid'>('prepaid');
  const [cableMode, setCableMode] = useState<'change' | 'renew'>('change');
  const [verified, setVerified] = useState<{ name?: string; address?: string; min?: number; accountType?: string; renewal?: number; bouquet?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [formError, setFormError] = useState('');
  // Bank
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [bankCode, setBankCode] = useState('');
  // International
  const [countries, setCountries] = useState<{ code: string; name: string; currency: string; prefix: string; flag?: string }[]>([]);
  const [country, setCountry] = useState('');
  const [products, setProducts] = useState<{ product_type_id: number; name: string }[]>([]);
  const [product, setProduct] = useState<{ product_type_id: number; name: string } | null>(null);
  const [operators, setOperators] = useState<{ operator_id: string; name: string; operator_image?: string }[]>([]);
  const [operator, setOperator] = useState<{ operator_id: string; name: string; operator_image?: string } | null>(null);
  const [intlPlans, setIntlPlans] = useState<{ variation_code: string; name: string; fixedPrice: string; variation_amount: string | null; variation_amount_min?: number; variation_amount_max?: number; variation_rate: number; charged_amount: string | null }[]>([]);
  const [intlPlan, setIntlPlan] = useState<(typeof intlPlans)[number] | null>(null);
  const [intlCurrency, setIntlCurrency] = useState('');

  const resetForm = () => {
    setProvider(''); setPlans([]); setPlan(null); setAccountNumber(''); setAmount(''); setVerified(null); setFormError('');
    setBankCode(''); setCountry(''); setProducts([]); setProduct(null); setOperators([]); setOperator(null); setIntlPlans([]); setIntlPlan(null);
  };

  useEffect(() => {
    if (!svc) return;
    const category = SERVICES.find((s) => s.id === svc)?.category;
    if (category) {
      getJson<{ providers: Provider[] }>(`/api/providers?category=${category}`)
        // Smile and Spectranet need an account lookup the mini app doesn't do; JAMB needs a profile check.
        .then((d) => setProviders((d.providers || []).filter((p) => !['smile-direct', 'spectranet', 'jamb'].includes(p.serviceID))))
        .catch(() => setProviders([]));
    }
    if (svc === 'BANK' && !banks.length) getJson<{ banks: { code: string; name: string }[] }>('/api/monnify/banks').then((d) => setBanks(d.banks || [])).catch(() => {});
    if (svc === 'INTL' && !countries.length) getJson<{ content: { countries: typeof countries } }>('/api/intl?action=countries').then((d) => setCountries(d.content?.countries || [])).catch(() => {});
  }, [svc, banks.length, countries.length]);

  // Plans for data, cable and exam PINs.
  useEffect(() => {
    if (!provider || !['DATA', 'CABLE', 'EDUCATION'].includes(svc || '')) return;
    getJson<{ content?: { variations?: Plan[] } }>(`/api/variations?serviceID=${encodeURIComponent(provider)}`)
      .then((d) => setPlans(d.content?.variations || []))
      .catch(() => {});
  }, [provider, svc]);

  // International drill-down: country → product → operator → plan. Changing a level clears the
  // levels below it in the change handler, so each effect only ever loads.
  useEffect(() => {
    if (!country) return;
    getJson<{ content: typeof products }>(`/api/intl?action=products&code=${country}`).then((d) => setProducts(Array.isArray(d.content) ? d.content : [])).catch(() => {});
  }, [country]);
  useEffect(() => {
    if (!country || !product) return;
    getJson<{ content: typeof operators }>(`/api/intl?action=operators&code=${country}&type_id=${product.product_type_id}`).then((d) => setOperators(Array.isArray(d.content) ? d.content : [])).catch(() => {});
  }, [country, product]);
  useEffect(() => {
    if (!operator || !product) return;
    getJson<{ content: { currency?: string; variations?: typeof intlPlans } }>(`/api/intl?action=variations&operator_id=${operator.operator_id}&type_id=${product.product_type_id}`)
      .then((d) => { setIntlPlans(d.content?.variations || []); setIntlCurrency(d.content?.currency || ''); })
      .catch(() => {});
  }, [operator, product]);

  // ── Verification (meter, smartcard, bank account) ────────────────────────────────────────────
  const verify = async () => {
    setVerifying(true); setVerified(null); setFormError('');
    try {
      if (svc === 'BANK') {
        const d = await getJson<{ success: boolean; accountName?: string; message?: string }>('/api/monnify/verify', { method: 'POST', body: JSON.stringify({ accountNumber: account_, bankCode }) });
        if (d.success && d.accountName) setVerified({ name: d.accountName });
        else setFormError(d.message || 'Could not verify this account.');
      } else {
        const d = await getJson<{ code?: string; content?: Record<string, unknown> }>('/api/verify', {
          method: 'POST',
          body: JSON.stringify({ billersCode: account_, serviceID: provider, type: svc === 'ELECTRICITY' ? meterType : undefined }),
        });
        const c = d.content || {};
        if (d.code === '000' && !c.error) {
          setVerified({
            name: String(c.Customer_Name || c.Customer_name || c.account_name || c.name || '') || undefined,
            address: c.Address ? String(c.Address) : undefined,
            min: c.Min_Purchase_Amount ? Number(c.Min_Purchase_Amount) : undefined,
            accountType: c.Customer_Account_Type ? String(c.Customer_Account_Type) : undefined,
            renewal: c.Renewal_Amount ? Number(c.Renewal_Amount) : undefined,
            bouquet: c.Current_Bouquet ? String(c.Current_Bouquet) : undefined,
          });
        } else setFormError('This number could not be verified. Check it and the provider.');
      }
    } catch {
      setFormError('Network error. Check your connection and try again.');
    } finally {
      setVerifying(false);
    }
  };

  // ── The bill, described exactly as the main app's buildBackendPayload describes it ───────────
  const needsVerify = svc === 'ELECTRICITY' || svc === 'BANK' || (svc === 'CABLE' && provider !== 'showmax');
  const intlNaira = useMemo(() => {
    if (!intlPlan) return 0;
    const rate = Number(intlPlan.variation_rate || 1);
    if (intlPlan.fixedPrice === 'Yes') {
      const charged = Number(intlPlan.charged_amount || 0);
      return charged > 0 ? charged : Number(intlPlan.variation_amount || 0) * rate;
    }
    return Number(amount || 0) * rate;
  }, [intlPlan, amount]);

  const bill = useMemo(() => {
    if (!svc) return null;
    const isRenew = svc === 'CABLE' && ['dstv', 'gotv'].includes(provider) && cableMode === 'renew';
    const naira =
      svc === 'INTL' ? intlNaira
      : svc === 'DATA' || svc === 'EDUCATION' || (svc === 'CABLE' && !isRenew) ? Number(plan?.variation_amount || 0)
      : isRenew ? Number(verified?.renewal || 0)
      : Number(amount || 0);
    if (!(naira > 0)) return null;

    const base = { nairaAmount: naira, phone: phone || account_, email: email || undefined, customer_name: verified?.name, customer_address: verified?.address };
    switch (svc) {
      case 'AIRTIME': return { ...base, serviceID: provider, serviceCategory: 'AIRTIME', network: provider.toUpperCase(), billersCode: phone, variation_code: 'none' };
      case 'DATA': return { ...base, serviceID: provider, serviceCategory: 'INTERNET', network: provider.toUpperCase(), billersCode: phone, variation_code: plan?.variation_code || 'none' };
      case 'ELECTRICITY': return { ...base, serviceID: provider, serviceCategory: 'ELECTRICITY', network: provider.toUpperCase(), billersCode: account_, variation_code: meterType, meter_account_type: verified?.accountType };
      case 'CABLE': return { ...base, serviceID: provider, serviceCategory: 'CABLE', network: provider.toUpperCase(), billersCode: account_, variation_code: isRenew ? 'none' : plan?.variation_code || 'none', subscription_type: ['dstv', 'gotv'].includes(provider) ? cableMode : undefined };
      case 'EDUCATION': return { ...base, serviceID: provider, serviceCategory: 'EDUCATION', network: provider.toUpperCase(), billersCode: phone, variation_code: plan?.variation_code || 'none' };
      case 'BANK': {
        const bank = banks.find((b) => b.code === bankCode);
        return { ...base, serviceID: 'moniepoint-transfer', serviceCategory: 'BANK', network: (bank?.name || '').toUpperCase(), billersCode: account_, variation_code: bankCode };
      }
      case 'INTL': {
        const foreign = intlPlan?.fixedPrice === 'Yes' ? intlPlan.variation_amount : amount;
        return {
          ...base, serviceID: 'foreign-airtime', serviceCategory: `INTL ${(product?.name || '').toUpperCase()}`, network: (operator?.name || '').toUpperCase(),
          billersCode: phone, variation_code: intlPlan?.variation_code || 'none', foreignAmount: foreign || undefined,
          displayAmount: `${intlCurrency || countries.find((c) => c.code === country)?.currency || country} ${foreign}`,
          operator_id: operator?.operator_id, country_code: country, product_type_id: product?.product_type_id,
        };
      }
    }
  }, [svc, provider, plan, phone, email, account_, amount, meterType, cableMode, verified, bankCode, banks, intlPlan, intlNaira, product, operator, country, countries, intlCurrency]);

  // Live estimate. The intent's quote is the binding one; this uses the same rule (src/lib/billCharges.ts
  // and lunaForUsd in src/lib/nimiq.ts) so the two agree.
  const estimate = useMemo(() => {
    if (!bill || !quote?.nim_usd) return null;
    const { serviceFee, stampDutyNgn } = billCharges({ serviceCategory: bill.serviceCategory, serviceID: bill.serviceID, network: bill.network, amountNgn: bill.nairaAmount });
    const usd = (bill.nairaAmount + serviceFee + stampDutyNgn) / quote.ngn_per_usd;
    const nim = Math.ceil((usd / quote.nim_usd) * (1 + quote.buffer));
    const fee = serviceFee + stampDutyNgn;
    return { nim, fee, nimUsd: nim * quote.nim_usd, feeUsd: fee / quote.ngn_per_usd };
  }, [bill, quote]);

  // The provider's own limits from the VTpass catalog — the same numbers the server's
  // checkWebPayment applies — shown and enforced as the amount is typed, as abapays.com does.
  const providerLimits = useMemo(() => {
    const p = providers.find((x) => x.serviceID === provider);
    return { min: p?.minAmount || null, max: p?.maxAmount || null };
  }, [providers, provider]);
  const typedNaira = Number(amount) || 0;
  const limitError = (svc === 'AIRTIME' || svc === 'ELECTRICITY') && typedNaira > 0
    ? (providerLimits.min && typedNaira < providerLimits.min ? `The minimum for this provider is ${ngn(providerLimits.min)}.`
      : providerLimits.max && typedNaira > providerLimits.max ? `The maximum for this provider is ${ngn(providerLimits.max)} per payment.` : '')
    : '';

  // 🔒 SAME CONTROLS AS abapays.com, asked of the server: the order as it stands goes through the
  // exact checkWebPayment gate createIntent runs (kill switches for the service and the provider,
  // the provider breaker, live min/max). Debounced; read-only. The server re-checks at Pay anyway.
  // Each answer is kept with the order it was asked for, so a stale one never applies to a newer order.
  const billKey = bill ? JSON.stringify(bill) : '';
  const [gate, setGate] = useState<{ key: string; allowed: boolean; reason?: string } | null>(null);
  useEffect(() => {
    if (!billKey) return;
    const t = setTimeout(() => {
      getJson<{ allowed: boolean; reason?: string }>('/api/pay/nim', { method: 'POST', body: JSON.stringify({ check: true, ...JSON.parse(billKey) }) })
        .then((g) => { if (typeof g?.allowed === 'boolean') setGate({ key: billKey, allowed: g.allowed, reason: g.reason }); })
        .catch(() => { /* the server re-checks at Pay */ });
    }, 400);
    return () => clearTimeout(t);
  }, [billKey]);
  const gateError = gate && gate.key === billKey && !gate.allowed ? (gate.reason || 'This service is unavailable right now.') : '';

  const formReady = (() => {
    if (!bill) return false;
    if (limitError || gateError) return false;
    if (svc === 'INTL') return !!(operator && intlPlan) && phone.replace(/\D/g, '').length >= 6;
    if (svc === 'BANK') return !!bankCode && !!verified?.name && isPhone(phone);
    if (!provider || !isPhone(phone)) return false;
    if (needsVerify && !verified?.name) return false;
    if (svc === 'ELECTRICITY' && verified?.min && bill.nairaAmount < verified.min) return false;
    return true;
  })();

  // ── Payment ────────────────────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{ code?: string | null; units?: string | null; requestId?: string; txHash?: string } | null>(null);

  const pay = async () => {
    if (!bill || !nimiq.current) return;
    setPhase('ordering'); setMessage('Pricing your order in NIM…'); setResult(null);
    let intent: Intent;
    try {
      // The server checks the balance on the Nimiq chain (INSUFFICIENT_NIM) — the displayed figure
      // is never the judge, so a stale "0" can't block a funded wallet.
      const d = await getJson<Intent & { success: boolean; message?: string; balance_luna?: number | null }>('/api/pay/nim', { method: 'POST', body: JSON.stringify({ intent: true, payer: account, ...bill }) });
      if (typeof d.balance_luna === 'number') setBalanceLuna(d.balance_luna);
      if (!d.success) { setPhase('failed'); setMessage(d.message || 'This order could not be started.'); return; }
      intent = d;
    } catch {
      setPhase('failed'); setMessage('Network error. Nothing was charged.'); return;
    }

    setPhase('signing'); setMessage(`Approve ${nimFmt(intent.nim)} in Nimiq Pay.`);
    let txHash = '';
    let uncertain = false; // Nimiq Pay answered "outcome unknown"
    try {
      // No validityStartHeight: the wallet fills in the current height itself.
      // 🔴 `data` IS PLAIN TEXT. Nimiq Pay writes it as UTF-8 recipient data (nimiq-pay-app
      // src/lib/tx.ts: BufferUtils.fromUtf8(message)), and a basic transaction may carry at most
      // 64 bytes (Albatross Policy::MAX_BASIC_TX_RECIPIENT_DATA_SIZE). We used to send it
      // hex-encoded: the 47-byte reference became 94 bytes, the cosigner couldn't get it accepted,
      // and Nimiq Pay showed the payment "Pending" → "outcome unknown" → failed (2026-10-17).
      const sent = unwrap(await nimiq.current.sendBasicTransactionWithData({ recipient: intent.recipient, value: intent.luna, data: intent.reference }));
      if (typeof sent === 'string' && /^[0-9a-f]{64}$/i.test(sent)) txHash = sent.toLowerCase();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const type = String((e as { type?: unknown })?.type || '');
      // Nimiq Pay is still holding an EARLIER send (2026-10-17, seen after "outcome unknown"):
      // this order was never sent. That earlier order is delivered if its payment lands, and
      // refunded by the cleanup sweep if it lands after expiry (nimSettle refundLatePayments).
      if (/still pending/i.test(text)) {
        setPhase('idle');
        setMessage('Nimiq Pay is still processing your previous payment, so this one wasn’t sent and nothing was charged for it. If the previous payment goes through, that order is delivered; if it arrives too late, it’s refunded. Please wait a few minutes before paying again.');
        return;
      }
      // "Outcome unknown": it may have been submitted. Don't stop here — watch the chain for this
      // order's reference (the server finds it without a hash) and say what actually happened.
      if (!(type === 'TRANSACTION_OUTCOME_UNKNOWN' || /outcome is unknown|may have been submitted/i.test(text))) {
        setPhase('idle');
        setMessage(/cancel|denied|reject|abort|dismiss|closed/i.test(text) ? 'Payment cancelled. Nothing was charged.' : `Nimiq Pay couldn’t send the payment: ${text}`);
        return;
      }
      uncertain = true;
    }

    setPhase('confirming');
    setMessage(uncertain ? 'Nimiq Pay isn’t sure the payment went out. Checking the Nimiq network for it…' : 'Payment sent. Waiting for the Nimiq network to confirm it…');
    const started = Date.now();
    while (Date.now() - started < (uncertain ? 3 : 5) * 60_000) {
      try {
        const d = await getJson<{ success: boolean; status: string; message?: string; purchased_code?: string | null; units?: string | null; request_id?: string; verifying?: boolean }>(
          '/api/pay/nim', { method: 'POST', body: JSON.stringify({ intent_id: intent.intent_id, tx_hash: txHash }) },
        );
        if (d.status === 'SUCCESS') {
          setPhase('done'); setResult({ code: d.purchased_code, units: d.units, requestId: d.request_id, txHash });
          setMessage(svc === 'BANK' ? 'Done! Your transfer has been sent.' : 'Done! Your purchase was delivered.');
          refreshBalance(account); return;
        }
        if (d.status === 'TIMEOUT' && !d.verifying) {
          setPhase('done'); setResult({ requestId: d.request_id, txHash });
          setMessage('Paid. Your order is finishing in the background; you’ll get a receipt by email if you added one.');
          refreshBalance(account); return;
        }
        if (d.status === 'FAILED_VENDING') {
          setPhase('failed'); setMessage(`${d.message || 'This order could not be completed.'} If NIM left your wallet, it is refunded to it.`);
          refreshBalance(account); return;
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 4_000));
    }
    setPhase('failed');
    setMessage(uncertain
      ? 'No payment from your wallet has reached AbaPay, so nothing has been charged so far. If Nimiq Pay sends it later, this order is delivered, or the NIM is refunded if it arrives after the order expires. Wait until Nimiq Pay no longer shows it as pending before paying again.'
      : 'Still confirming after five minutes. Your payment is safe: the order completes, or the NIM is refunded, once the network confirms it.');
  };

  // ── Render ─────────────────────────────────────────────────────────────────────────────────
  if (env === 'loading') {
    return <Centered><Loader2 className="animate-spin text-[#E9B213]" size={28} /><p className="text-sm mt-3 opacity-70">Connecting to Nimiq Pay…</p></Centered>;
  }
  if (env === 'outside') {
    return (
      <Centered footer>
        <Brand />
        <h1 className="text-2xl font-black mt-6 text-center">Pay Nigerian bills with NIM</h1>
        <p className="text-sm opacity-70 mt-2 text-center max-w-sm">Airtime, data, electricity, cable TV, exam PINs, bank transfers and international top-ups. This app runs inside Nimiq Pay.</p>
        <a href={OPEN_IN_NIMIQ_PAY} className="mt-6 px-6 py-3 rounded-full bg-[#E9B213] text-[#1F2348] font-black text-sm">Open in Nimiq Pay</a>
        <a href="https://www.abapays.com" className="mt-4 text-xs underline opacity-60">Paying with stablecoins? Use abapays.com</a>
      </Centered>
    );
  }
  if (env === 'disconnected') {
    return (
      <Centered footer>
        <Brand />
        <h1 className="text-2xl font-black mt-6 text-center">Connect your wallet</h1>
        <p className="text-sm opacity-70 mt-2 text-center max-w-sm">AbaPay needs your Nimiq address to price your bill and confirm your payment. It can never move your NIM: every payment is approved by you in Nimiq Pay.</p>
        <button type="button" onClick={() => void connect()} disabled={connecting}
          className="mt-6 px-6 py-3 rounded-full bg-[#E9B213] text-[#1F2348] font-black text-sm inline-flex items-center gap-2 disabled:opacity-60">
          {connecting ? <Loader2 size={16} className="animate-spin" /> : <Wallet size={16} />} {connecting ? 'Waiting for Nimiq Pay…' : 'Connect wallet'}
        </button>
        {connectError && <div className="mt-4 max-w-sm"><Note tone="warn">{connectError}</Note></div>}
      </Centered>
    );
  }

  const busy = phase === 'ordering' || phase === 'signing' || phase === 'confirming';
  const balanceUsd = balanceLuna !== null && quote?.nim_usd ? (balanceLuna / LUNA) * quote.nim_usd : null;

  return (
    // Full-height column: the footer (mt-auto) sits just above the tab bar on a short screen
    // instead of leaving an empty band under it.
    <div className="max-w-md mx-auto px-4 py-5 pb-24 min-h-[100dvh] flex flex-col">
      <header className="flex items-center justify-between mb-5">
        <Brand />
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest font-bold opacity-50">Balance</p>
          <p className="text-sm font-black tabular-nums">{balanceLuna === null ? '—' : nimBalanceFmt(balanceLuna / LUNA)}</p>
          {balanceUsd !== null && <p className="text-[10px] opacity-60 tabular-nums">≈ {usdFmt(balanceUsd)}</p>}
          {/* The address the balance is read for — copyable, so a wrong account is easy to spot. */}
          <div className="mt-1 flex items-center justify-end gap-2 text-[10px] font-bold">
            <button type="button" title={`Copy ${account}`} className="inline-flex items-center gap-1 opacity-60 hover:opacity-100"
              onClick={() => { void navigator.clipboard?.writeText(account).then(() => { setAddrCopied(true); setTimeout(() => setAddrCopied(false), 1500); }).catch(() => {}); }}>
              {account ? `${account.replace(/\s+/g, '').slice(0, 4)}…${account.replace(/\s+/g, '').slice(-4)}` : ''} {addrCopied ? <Check size={10} /> : <Copy size={10} />}
            </button>
            <button type="button" onClick={disconnect} disabled={busy} className="inline-flex items-center gap-1 opacity-60 hover:opacity-100 disabled:opacity-30">
              <LogOut size={10} /> Disconnect
            </button>
          </div>
        </div>
      </header>

      {hostNetwork === 'testnet' && (
        <div className="mb-4"><Note tone="warn">Nimiq Pay is on the test network, so your balance here is the testnet one. AbaPay takes mainnet NIM: switch Nimiq Pay to mainnet to pay.</Note></div>
      )}

      {quote && !quote.available && (
        <div className="mb-4"><Note tone="warn">NIM payments are paused right now. Please try again shortly.</Note></div>
      )}

      {tab === 'history' ? (
        <>
          <h1 className="text-xl font-black mb-4">History</h1>
          <HistoryView nimiq={wallet} account={account} logos={logos} />
        </>
      ) : !svc ? (
        <>
          <h1 className="text-xl font-black mb-1">What do you want to pay?</h1>
          <p className="text-xs opacity-60 mb-4">Paid in NIM, delivered in Nigeria and 140+ countries.{quote?.nim_usd ? ` 1 NIM ≈ ${usdFmt(quote.nim_usd)}.` : ''}</p>
          <div className="grid grid-cols-2 gap-3">
            {SERVICES.map((s) => {
              // Switched off in the admin for abapays.com → off here too (same gate, see the quote).
              const off = quote?.services?.[s.id]?.available === false;
              return (
                <button key={s.id} type="button" disabled={off} title={off ? quote?.services?.[s.id]?.reason : undefined}
                  onClick={() => { resetForm(); setSvc(s.id); setPhase('idle'); setMessage(''); }}
                  className="flex flex-col items-start gap-3 p-4 rounded-2xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 text-left active:scale-[0.98] transition disabled:opacity-40 disabled:active:scale-100">
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.bg}`}><s.icon size={20} className={s.color} /></span>
                  <span className="text-sm font-black">{s.label}</span>
                  {off && <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Unavailable</span>}
                </button>
              );
            })}
          </div>
        </>
      ) : phase === 'done' || phase === 'failed' ? (
        <ResultCard ok={phase === 'done'} message={message} result={result} onDone={() => { setSvc(null); setPhase('idle'); setMessage(''); resetForm(); }} onRetry={() => { setPhase('idle'); setMessage(''); }} />
      ) : (
        <div>
          <button type="button" onClick={() => { setSvc(null); resetForm(); setMessage(''); }} disabled={busy} className="flex items-center gap-1 text-xs font-bold opacity-60 mb-3"><ChevronLeft size={14} /> All services</button>
          <h1 className="text-xl font-black mb-4">{SERVICES.find((s) => s.id === svc)?.label}</h1>

          <div className="space-y-3">
            {svc !== 'BANK' && svc !== 'INTL' && (
              <Field label="Provider">
                <Picker title="Choose a provider" value={provider} searchable={providers.length > 6}
                  items={providers.map((p) => ({ id: p.serviceID, label: p.displayName, image: p.logo }))}
                  onSelect={(id) => { setProvider(id); setVerified(null); setPlans([]); setPlan(null); }} />
              </Field>
            )}

            {svc === 'BANK' && (
              <Field label="Bank">
                <Picker title="Choose a bank" value={bankCode} searchable placeholder="Search banks"
                  items={banks.map((b) => ({ id: b.code, label: b.name }))}
                  onSelect={(id) => { setBankCode(id); setVerified(null); }} />
              </Field>
            )}

            {svc === 'INTL' && (
              <>
                <Field label="Country">
                  <Picker title="Choose a country" value={country} searchable placeholder="Search countries"
                    items={countries.map((c) => ({ id: c.code, label: c.name, sub: `+${c.prefix} · ${c.currency}`, image: c.flag, keywords: `${c.code} ${c.prefix} ${c.currency}` }))}
                    onSelect={(id) => { setCountry(id); setProducts([]); setProduct(null); setOperators([]); setOperator(null); setIntlPlans([]); setIntlPlan(null); }} />
                </Field>
                {products.length > 0 && (
                  <Field label="Product">
                    <Picker title="Choose a product" value={product ? String(product.product_type_id) : ''}
                      items={products.map((p) => ({ id: String(p.product_type_id), label: p.name }))}
                      onSelect={(id) => { setProduct(products.find((p) => String(p.product_type_id) === id) || null); setOperators([]); setOperator(null); setIntlPlans([]); setIntlPlan(null); }} />
                  </Field>
                )}
                {operators.length > 0 && (
                  <Field label="Operator">
                    <Picker title="Choose an operator" value={operator?.operator_id ?? ''} searchable={operators.length > 6}
                      items={operators.map((o) => ({ id: o.operator_id, label: o.name, image: o.operator_image }))}
                      onSelect={(id) => { setOperator(operators.find((o) => o.operator_id === id) || null); setIntlPlans([]); setIntlPlan(null); }} />
                  </Field>
                )}
                {intlPlans.length > 0 && (
                  <Field label="Plan">
                    <Picker title="Choose a plan" value={intlPlan?.variation_code ?? ''} searchable={intlPlans.length > 8} placeholder="Search plans"
                      items={intlPlans.map((p) => ({ id: p.variation_code, label: p.name, image: operator?.operator_image }))}
                      onSelect={(id) => setIntlPlan(intlPlans.find((p) => p.variation_code === id) || null)} />
                  </Field>
                )}
                {intlPlan && intlPlan.fixedPrice !== 'Yes' && (
                  <Field label={`Amount (${intlCurrency}${intlPlan.variation_amount_min ? `, ${intlPlan.variation_amount_min}–${intlPlan.variation_amount_max}` : ''})`}>
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className={input} />
                  </Field>
                )}
              </>
            )}

            {svc === 'ELECTRICITY' && (
              <div className="grid grid-cols-2 gap-2">
                {(['prepaid', 'postpaid'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => { setMeterType(t); setVerified(null); }} className={`py-2.5 rounded-xl text-xs font-black capitalize ${meterType === t ? 'bg-[#1F2348] text-white dark:bg-[#E9B213] dark:text-[#1F2348]' : 'bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10'}`}>{t}</button>
                ))}
              </div>
            )}

            {(svc === 'ELECTRICITY' || svc === 'CABLE' || svc === 'BANK') && (
              <Field label={svc === 'ELECTRICITY' ? 'Meter number' : svc === 'CABLE' ? 'Smartcard / IUC number' : 'Account number'}>
                <div className="flex gap-2">
                  <input inputMode="numeric" value={account_} onChange={(e) => { setAccountNumber(e.target.value.replace(/\D/g, '')); setVerified(null); }} className={input} />
                  {needsVerify && (
                    <button type="button" onClick={verify} disabled={verifying || account_.length < 6 || (svc === 'BANK' ? !bankCode : !provider)}
                      className="px-4 rounded-xl bg-[#1F2348] text-white dark:bg-[#E9B213] dark:text-[#1F2348] text-xs font-black disabled:opacity-40">
                      {verifying ? <Loader2 size={14} className="animate-spin" /> : 'Verify'}
                    </button>
                  )}
                </div>
              </Field>
            )}

            {verified?.name && (
              <Note tone="ok">
                <b>{verified.name}</b>
                {verified.address && <span className="block opacity-70">{verified.address}</span>}
                {verified.bouquet && <span className="block opacity-70">Current: {verified.bouquet}</span>}
                {verified.min && <span className="block opacity-70">Minimum purchase {ngn(verified.min)}</span>}
              </Note>
            )}

            {svc === 'CABLE' && ['dstv', 'gotv'].includes(provider) && verified?.renewal && (
              <div className="grid grid-cols-2 gap-2">
                {(['renew', 'change'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setCableMode(m)} className={`py-2.5 rounded-xl text-xs font-black ${cableMode === m ? 'bg-[#1F2348] text-white dark:bg-[#E9B213] dark:text-[#1F2348]' : 'bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10'}`}>
                    {m === 'renew' ? `Renew (${ngn(verified.renewal!)})` : 'Change package'}
                  </button>
                ))}
              </div>
            )}

            {(svc === 'DATA' || svc === 'EDUCATION' || (svc === 'CABLE' && !(['dstv', 'gotv'].includes(provider) && cableMode === 'renew' && verified?.renewal))) && plans.length > 0 && (
              <Field label={svc === 'EDUCATION' ? 'PIN type' : svc === 'CABLE' ? 'Package' : 'Plan'}>
                <Picker title={svc === 'EDUCATION' ? 'Choose a PIN type' : svc === 'CABLE' ? 'Choose a package' : 'Choose a plan'} value={plan?.variation_code ?? ''}
                  searchable={plans.length > 8} placeholder="Search plans"
                  items={plans.map((p) => ({ id: p.variation_code, label: p.name, image: providers.find((x) => x.serviceID === provider)?.logo, right: ngn(Number(p.variation_amount)) }))}
                  onSelect={(id) => setPlan(plans.find((p) => p.variation_code === id) || null)} />
              </Field>
            )}

            {(svc === 'AIRTIME' || svc === 'ELECTRICITY' || svc === 'BANK') && (
              <Field label={`Amount (₦)${providerLimits.min || providerLimits.max ? ` · ${providerLimits.min ? `min ${ngn(providerLimits.min)}` : ''}${providerLimits.min && providerLimits.max ? ', ' : ''}${providerLimits.max ? `max ${ngn(providerLimits.max)}` : ''}` : ''}`}>
                <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} className={input} />
                <div className="flex flex-wrap gap-2 mt-2">
                  {(svc === 'ELECTRICITY' ? ELEC_PRESETS : AIRTIME_PRESETS).map((v) => (
                    <button key={v} type="button" onClick={() => setAmount(String(v))} className="px-3 py-1.5 rounded-full text-[11px] font-black bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10">{ngn(v)}</button>
                  ))}
                </div>
              </Field>
            )}

            <Field label={svc === 'INTL' ? 'Phone number (with country code)' : svc === 'BANK' || svc === 'ELECTRICITY' || svc === 'CABLE' ? 'Your phone number' : 'Phone number'}>
              <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))} placeholder={svc === 'INTL' ? `${countries.find((c) => c.code === country)?.prefix || ''}…` : '080…'} className={input} />
            </Field>

            {(svc === 'ELECTRICITY' || svc === 'EDUCATION') && (
              <Field label="Email for your token / PIN (optional)">
                <input inputMode="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} className={input} />
              </Field>
            )}

            {formError && <Note tone="warn">{formError}</Note>}
            {!formError && (limitError || gateError) && <Note tone="warn">{limitError || gateError}</Note>}
          </div>

          <div className="mt-5 rounded-2xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 p-4">
            {/* A Nigerian bill is priced in naira; an international one in the destination's own
                currency (as abapays.com shows it); what the customer pays is NIM, with its USD value. */}
            <div className="flex justify-between text-xs opacity-70"><span>Bill</span><span className="tabular-nums">{!bill ? '—' : svc === 'INTL' && 'displayAmount' in bill && bill.displayAmount ? bill.displayAmount : ngn(bill.nairaAmount)}</span></div>
            {estimate && estimate.fee > 0 && <div className="flex justify-between text-xs opacity-70 mt-1"><span>Service fee</span><span className="tabular-nums">{svc === 'INTL' ? usdFmt(estimate.feeUsd) : ngn(estimate.fee)}</span></div>}
            <div className="flex justify-between items-baseline mt-2">
              <span className="text-sm font-black">You pay</span>
              <span className="text-right">
                <span className="block text-xl font-black tabular-nums">{estimate ? `≈ ${nimFmt(estimate.nim)}` : '—'}</span>
                {estimate && <span className="block text-[11px] opacity-60 tabular-nums">≈ {usdFmt(estimate.nimUsd)}</span>}
              </span>
            </div>
            <p className="text-[10px] opacity-50 mt-1">Final NIM amount is fixed when you tap Pay.</p>
          </div>

          {message && phase !== 'idle' && <p className="text-xs mt-3 opacity-80 flex items-center gap-2"><Loader2 size={12} className="animate-spin" />{message}</p>}
          {message && phase === 'idle' && <Note tone="warn">{message}</Note>}

          <button type="button" onClick={pay} disabled={!formReady || busy || !quote?.available}
            className="mt-4 w-full py-4 rounded-full bg-[#E9B213] text-[#1F2348] font-black text-sm disabled:opacity-40 flex items-center justify-center gap-2">
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {busy ? 'Working…' : estimate ? `Pay ${nimFmt(estimate.nim)}` : 'Pay with NIM'}
          </button>
        </div>
      )}

      <NimFooter />

      {/* Pay / History. Hidden mid-payment, so a tab switch can't hide a payment in progress. */}
      {!busy && (
        <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-black/5 dark:border-white/10 bg-white/95 dark:bg-[#1F2348]/95 backdrop-blur" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="max-w-md mx-auto grid grid-cols-2">
            {([['pay', 'Pay', Home], ['history', 'History', HistoryIcon]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-black ${tab === id ? 'text-[#E9B213]' : 'opacity-50'}`}>
                <Icon size={20} />{label}
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

const input = 'w-full px-3 py-3 rounded-xl bg-white dark:bg-[#1F2348] border border-black/10 dark:border-white/10 text-sm outline-none focus:border-[#E9B213]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-wider opacity-60 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function Note({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl px-3 py-2.5 text-xs mt-3 ${tone === 'ok' ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-800 dark:text-amber-300'}`}>{children}</div>
  );
}

// The abapays.com footer (src/components/AppFooter.tsx): X and Telegram community links, the
// network badge, Docs / Terms / Privacy, and the company line. All three pages are served on this
// host (middleware.ts NIM_HOST_SKIP), so a NIM user's Back never lands on abapays.com.
const footerLink = 'text-[10px] font-black opacity-60 hover:opacity-100 uppercase transition-opacity';
const footerIcon = 'w-11 h-11 rounded-full border-2 border-black/10 dark:border-white/15 bg-white dark:bg-[#1F2348] flex items-center justify-center opacity-80 hover:opacity-100 transition';

function NimFooter() {
  return (
    // mt-auto: pinned to the bottom of its full-height column (no empty band below it); the
    // pt-12 wrapper keeps the gap above it when the page is long.
    <div className="mt-auto pt-12 w-full">
    <footer className="w-full border-t border-black/5 dark:border-white/10 pt-8 pb-4 flex flex-col items-center gap-5">
      <div className="flex items-center gap-4">
        <a href="https://x.com/AbaPays" target="_blank" rel="noopener noreferrer" aria-label="AbaPay on X" className={footerIcon}>
          <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
        <a href="https://t.me/AbaPays" target="_blank" rel="noopener noreferrer" aria-label="AbaPay on Telegram" className={footerIcon}>
          <Send size={18} className="ml-[-2px] mt-[2px]" />
        </a>
      </div>
      <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10">
        <ShieldCheck size={15} className="text-[#E9B213]" />
        <span className="text-[11px] font-bold opacity-70 uppercase tracking-widest">Secured by Nimiq Network</span>
      </div>
      {/* Listed in Nimiq's official Mini Apps catalogue (nimiq/awesome#45, merged 2026-10-20). */}
      <a href="https://github.com/nimiq/awesome" target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-[11px] font-bold opacity-70 hover:opacity-100 transition-opacity">
        <CheckCircle2 size={13} className="text-[#E9B213]" /> Listed in Nimiq Pay Mini Apps
      </a>
      <div className="flex items-center gap-5">
        {/* On this host (middleware.ts serves /docs here), so its Back returns to the NIM app. */}
        <a href="/docs" className={footerLink}>Docs &amp; FAQ</a>
        <a href="/terms" className={footerLink}>Terms</a>
        <a href="/privacy" className={footerLink}>Privacy</a>
      </div>
      <p className="text-[9px] font-medium opacity-40 uppercase tracking-[0.2em] text-center">© 2026 MASONODE TECHNOLOGIES LIMITED • RC 9524980 • v3.1</p>
    </footer>
    </div>
  );
}

/** A centred screen; with `footer`, the footer sits at the bottom and the content stays centred. */
function Centered({ children, footer = false }: { children: React.ReactNode; footer?: boolean }) {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center px-6">
      <div className="flex-1 w-full flex flex-col items-center justify-center">{children}</div>
      {footer && <div className="w-full max-w-md"><NimFooter /></div>}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/abapay-logo.svg" alt="" width={28} height={28} className="object-contain" />
      <span className="font-black tracking-tight">AbaPay <span className="text-[#E9B213]">NIM</span></span>
    </div>
  );
}

function ResultCard({ ok, message, result, onDone, onRetry }: {
  ok: boolean; message: string;
  result: { code?: string | null; units?: string | null; requestId?: string; txHash?: string } | null;
  onDone: () => void; onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-3xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 p-6 text-center">
      {ok ? <CheckCircle2 size={44} className="mx-auto text-emerald-500" /> : <XCircle size={44} className="mx-auto text-rose-500" />}
      <p className="mt-3 text-sm font-bold">{message}</p>
      {result?.code && (
        <div className="mt-4 rounded-xl bg-black/5 dark:bg-white/5 p-3">
          <p className="text-[10px] uppercase tracking-widest opacity-60">Token / PIN</p>
          <p className="font-mono font-black text-lg break-all">{result.code}</p>
          {result.units && <p className="text-xs opacity-70">{result.units}</p>}
          <button type="button" onClick={() => { navigator.clipboard?.writeText(result.code || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-[#E9B213]">
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2 text-xs">
        {result?.requestId && <a href={`/receipt/${result.requestId}`} className="inline-flex items-center justify-center gap-1 font-bold underline">Receipt <ExternalLink size={11} /></a>}
        {result?.txHash && <a href={`https://nimiq.watch/#${result.txHash}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-1 opacity-70 underline">View payment on Nimiq <ExternalLink size={11} /></a>}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        {!ok && <button type="button" onClick={onRetry} className="py-3 rounded-full border border-black/10 dark:border-white/10 text-xs font-black">Back to form</button>}
        <button type="button" onClick={onDone} className={`py-3 rounded-full bg-[#E9B213] text-[#1F2348] text-xs font-black ${ok ? 'col-span-2' : ''}`}>New payment</button>
      </div>
    </div>
  );
}

// ── Picker — a searchable bottom sheet in place of the system <select> ─────────────────────────

type PickerItem = { id: string; label: string; sub?: string; image?: string; right?: string; keywords?: string };

/** A provider logo, country flag or operator image from VTpass, with initials when there is none or it fails to load. */
function Logo({ src, label, size = 32 }: { src?: string; label: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = label.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '•';
  if (!src || failed) {
    return (
      <span style={{ width: size, height: size }} className="flex-shrink-0 rounded-full bg-[#1F2348]/10 dark:bg-white/10 flex items-center justify-center text-[10px] font-black text-[#1F2348]/70 dark:text-white/70">
        {initials}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)}
      style={{ width: size, height: size }} className="flex-shrink-0 rounded-full object-cover bg-white border border-black/5" />
  );
}

function Picker({ title, items, value, onSelect, searchable = false, placeholder = 'Search' }: {
  title: string; items: PickerItem[]; value: string; onSelect: (id: string) => void; searchable?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = items.find((i) => i.id === value);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    // Names that start with the search come first ("gha" → Ghana before Afghanistan).
    const rank = (i: PickerItem) => (i.label.toLowerCase().startsWith(term) ? 0 : i.label.toLowerCase().split(/s+/).some((w) => w.startsWith(term)) ? 1 : 2);
    return items
      .filter((i) => `${i.label} ${i.sub || ''} ${i.keywords || ''}`.toLowerCase().includes(term))
      .sort((a, b) => rank(a) - rank(b));
  }, [items, q]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => { setQ(''); setOpen(true); }} disabled={!items.length}
        className={`${input} flex items-center gap-3 text-left disabled:opacity-50`}>
        {selected ? <Logo src={selected.image} label={selected.label} size={28} /> : null}
        <span className={`flex-1 min-w-0 truncate ${selected ? 'font-bold' : 'opacity-50'}`}>{selected ? selected.label : items.length ? 'Choose…' : 'Loading…'}</span>
        {selected?.right && <span className="text-xs font-black tabular-nums opacity-70">{selected.right}</span>}
        <ChevronDown size={16} className="opacity-50 flex-shrink-0" />
      </button>

      {/* Portalled to <body>: the picker sits inside a <label>, and a click inside a label re-clicks
          its trigger button, which reopened the sheet the moment an item was picked. */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <div className="relative w-full max-w-md max-h-[85vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#F8F8F8] dark:bg-[#14162B] shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
              <h2 className="text-base font-black">{title}</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="p-1.5 rounded-full bg-black/5 dark:bg-white/10"><X size={16} /></button>
            </div>
            {searchable && (
              <div className="px-5 pb-3">
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white dark:bg-[#1F2348] border border-black/10 dark:border-white/10 focus-within:border-[#E9B213]">
                  <Search size={15} className="opacity-50" />
                  <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="flex-1 bg-transparent text-sm outline-none" />
                  {q && <button type="button" onClick={() => setQ('')} aria-label="Clear"><X size={14} className="opacity-50" /></button>}
                </div>
              </div>
            )}
            <ul className="flex-1 overflow-y-auto px-3 pb-6">
              {shown.length === 0 && <li className="px-3 py-8 text-center text-sm opacity-60">No matches for “{q}”.</li>}
              {shown.map((i) => (
                <li key={i.id}>
                  <button type="button" onClick={() => { onSelect(i.id); setOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left active:scale-[0.99] transition ${i.id === value ? 'bg-[#E9B213]/15' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
                    <Logo src={i.image} label={i.label} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-bold truncate">{i.label}</span>
                      {i.sub && <span className="block text-[11px] opacity-60 truncate">{i.sub}</span>}
                    </span>
                    {i.right && <span className="text-xs font-black tabular-nums">{i.right}</span>}
                    {i.id === value && <Check size={16} className="text-[#E9B213] flex-shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── History ──────────────────────────────────────────────────────────────────────────────────

type HistoryRow = {
  created_at: string; status: string; service_category: string | null; service_id: string | null; network: string | null;
  account_number: string | null; amount_naira: number | string | null; display_amount: string | null; amount_usdt: number | string | null;
  tx_hash: string | null; request_id: string | null; error_code?: string | null; purchased_code: string | null; units: string | null;
};
type HistorySession = { message: string; signature: string; publicKey: string };

const SESSION_KEY = 'abapay-nim-history-session';

/**
 * The signed-in history, scoped server-side to the address the signature proves
 * (src/app/api/pay/nim/history). The signature is kept for this browsing session only, so the
 * user signs once rather than on every visit to the tab.
 */
function HistoryView({ nimiq, account, logos }: { nimiq: NimiqProvider | null; account: string; logos: Record<string, string> }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [state, setState] = useState<'idle' | 'signing' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  const load = useCallback(async (session: HistorySession) => {
    setState('loading'); setError('');
    const res = await fetch('/api/pay/nim/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
      setState('error'); setError(d.error || 'Could not load your history.'); return;
    }
    setRows(d.transactions || []); setState('idle');
  }, []);

  // Reuse this session's signature when it was made by the same address.
  useEffect(() => {
    let saved: (HistorySession & { address: string }) | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.address !== account) return;
    const session = saved;
    const t = setTimeout(() => { void load(session); }, 0);
    return () => clearTimeout(t);
  }, [account, load]);

  const signIn = async () => {
    if (!nimiq) return;
    setState('signing'); setError('');
    try {
      const message = `AbaPay: show my order history\nAddress: ${account.replace(/\s+/g, '').toUpperCase()}\nIssued: ${new Date().toISOString()}`;
      const signed = unwrap(await nimiq.sign(message)) as { publicKey: string; signature: string };
      const session = { message, signature: signed.signature, publicKey: signed.publicKey };
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ address: account, ...session })); } catch { /* storage unavailable */ }
      await load(session);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setState('error');
      setError(/cancel|denied|reject|abort|dismiss|closed/i.test(text) ? 'Signing was cancelled.' : `Couldn’t sign in: ${text}`);
    }
  };

  if (rows === null) {
    return (
      <div className="rounded-3xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 p-6 text-center">
        <span className="w-12 h-12 mx-auto rounded-2xl bg-[#E9B213]/15 flex items-center justify-center"><HistoryIcon size={22} className="text-[#E9B213]" /></span>
        <h2 className="text-lg font-black mt-3">Your orders</h2>
        <p className="text-xs opacity-60 mt-1 max-w-xs mx-auto">Sign a short message in Nimiq Pay to prove this wallet is yours. It costs nothing and moves no funds.</p>
        <button type="button" onClick={signIn} disabled={state === 'signing' || state === 'loading'}
          className="mt-5 px-6 py-3 rounded-full bg-[#E9B213] text-[#1F2348] font-black text-sm disabled:opacity-50 inline-flex items-center gap-2">
          {(state === 'signing' || state === 'loading') && <Loader2 size={14} className="animate-spin" />}
          {state === 'signing' ? 'Approve in Nimiq Pay…' : state === 'loading' ? 'Loading…' : 'Show my history'}
        </button>
        {error && <Note tone="warn">{error}</Note>}
      </div>
    );
  }

  if (rows.length === 0) {
    return <div className="rounded-3xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 p-8 text-center text-sm opacity-70">No orders yet. Your NIM payments will show up here.</div>;
  }

  return (
    <ul className="space-y-3">
      {rows.map((r) => <HistoryCard key={r.tx_hash} row={r} logo={r.service_id ? logos[r.service_id] : undefined} />)}
    </ul>
  );
}

function HistoryCard({ row, logo }: { row: HistoryRow; logo?: string }) {
  const [copied, setCopied] = useState(false);
  const category = String(row.service_category || '').toUpperCase();
  const svc = SERVICES.find((s) => s.id === (category.startsWith('INTL') ? 'INTL' : CATEGORY_OF[category]));
  // An order with no payment hash yet is waiting for its NIM (Nimiq Pay may still be holding the
  // send). Each state says, in a line, what it means for the customer's money.
  const awaiting = row.status === 'PENDING' && !row.tx_hash;
  const lateRefund = row.status === 'EXPIRED' && row.error_code === 'NIM_LATE_PAYMENT';
  const status = row.status === 'SUCCESS' ? { text: 'Delivered', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', note: '' }
    : row.status === 'REFUNDED' ? { text: 'Refunded', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', note: '' }
    : awaiting ? { text: 'Awaiting payment', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', note: 'Your NIM hasn’t reached AbaPay yet. If Nimiq Pay still shows this payment as pending, the order is delivered as soon as it arrives. If nothing arrives within an hour, it expires and nothing is charged.' }
    : row.status === 'PROCESSING' || row.status === 'PENDING' ? { text: 'Processing', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', note: 'Payment received. Your order is being delivered.' }
    : lateRefund ? { text: 'Refund on the way', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', note: 'Your NIM arrived after this order had expired, so it’s being sent back to your wallet.' }
    : row.status === 'EXPIRED' ? { text: 'Expired · not paid', cls: 'bg-black/5 dark:bg-white/10', note: 'No NIM arrived for this order, so nothing was charged.' }
    : { text: 'Failed · refund due', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300', note: 'Your NIM is being refunded to your wallet.' };
  const naira = row.display_amount || (row.amount_naira ? ngn(Number(row.amount_naira)) : '');
  return (
    <li className="rounded-2xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 p-4">
      <div className="flex items-start gap-3">
        {logo ? <Logo src={logo} label={row.network || ''} size={40} />
          : svc ? <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${svc.bg}`}><svc.icon size={20} className={svc.color} /></span>
          : <Logo label={row.network || '?'} size={40} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-black truncate">{(row.network || '').replace(/-/g, ' ')} {svc?.label || row.service_category}</p>
            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap ${status.cls}`}>{status.text}</span>
          </div>
          <p className="text-[11px] opacity-60 truncate">{row.account_number}</p>
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[11px] opacity-60 inline-flex items-center gap-1"><Clock size={11} />{new Date(row.created_at).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="text-xs font-black tabular-nums">{naira}{row.amount_usdt ? <span className="opacity-60 font-bold"> · {nimFmt(Number(row.amount_usdt))}</span> : null}</span>
          </div>
        </div>
      </div>
      {status.note && <p className="mt-2 text-[11px] opacity-70 leading-snug">{status.note}</p>}
      {row.purchased_code && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-black/5 dark:bg-white/5 px-3 py-2">
          <span className="min-w-0">
            <span className="block text-[10px] uppercase tracking-widest opacity-60">Token / PIN</span>
            <span className="block font-mono text-sm font-black break-all">{row.purchased_code}</span>
            {row.units && <span className="block text-[11px] opacity-60">{row.units}</span>}
          </span>
          <button type="button" onClick={() => { navigator.clipboard?.writeText(row.purchased_code || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); }} aria-label="Copy" className="p-2 rounded-lg text-[#E9B213]">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      )}
      <div className="mt-2 flex gap-4 text-[11px] font-bold">
        {row.request_id && row.status === 'SUCCESS' && <a href={`/receipt/${row.request_id}`} className="inline-flex items-center gap-1 underline">Receipt <ExternalLink size={10} /></a>}
        {row.tx_hash && /^[0-9a-f]{64}$/.test(row.tx_hash) && <a href={`https://nimiq.watch/#${row.tx_hash}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline opacity-70">Payment <ExternalLink size={10} /></a>}
      </div>
    </li>
  );
}
