'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { init, type NimiqProvider } from '@nimiq/mini-app-sdk';
import { Phone, Wifi, Lightbulb, Tv, GraduationCap, Landmark, Globe2, Loader2, CheckCircle2, XCircle, ExternalLink, Copy, Check, ChevronLeft } from 'lucide-react';
import { billCharges } from '@/lib/billCharges';

// ⚡ THE NIMIQ PAY MINI APP — every service abapays.com sells, paid in NIM.
//
// Flow, all against the NIM rail (src/app/api/pay/nim/route.ts):
//   1. the bill is described exactly as the main app describes it (same serviceID, category,
//      network, variation and customer fields), so the vend pipeline can't tell the difference;
//   2. POST { intent: true } → the server prices it in NIM and returns the treasury, the luna owed
//      and a reference;
//   3. Nimiq Pay sends the NIM with the reference as hex-encoded UTF-8 data (plain text is not
//      valid hex, and the host would drop it);
//   4. POST { intent_id, tx_hash } until the server has checked the payment on chain and vended.
//      Nimiq Pay doesn't always return a usable hash, so the server can also find the payment by
//      its reference.

type Svc = 'AIRTIME' | 'DATA' | 'ELECTRICITY' | 'CABLE' | 'EDUCATION' | 'BANK' | 'INTL';
type Provider = { serviceID: string; displayName: string; logo?: string; minAmount?: number; maxAmount?: number };
type Plan = { variation_code: string; name: string; variation_amount: string };
type Quote = { available: boolean; nim_usd: number | null; ngn_per_usd: number; buffer: number };
type Intent = { intent_id: string; recipient: string; luna: number; nim: number; reference: string };
type Phase = 'idle' | 'ordering' | 'signing' | 'confirming' | 'done' | 'failed';

const SERVICES: { id: Svc; label: string; icon: typeof Phone; category?: string }[] = [
  { id: 'AIRTIME', label: 'Airtime', icon: Phone, category: 'airtime' },
  { id: 'DATA', label: 'Data', icon: Wifi, category: 'data' },
  { id: 'ELECTRICITY', label: 'Electricity', icon: Lightbulb, category: 'electricity-bill' },
  { id: 'CABLE', label: 'Cable TV', icon: Tv, category: 'tv-subscription' },
  { id: 'EDUCATION', label: 'Exam PINs', icon: GraduationCap, category: 'education' },
  { id: 'BANK', label: 'Bank transfer', icon: Landmark },
  { id: 'INTL', label: 'International', icon: Globe2 },
];

const LUNA = 100_000;
const AIRTIME_PRESETS = [200, 500, 1000, 2000, 5000];
const ELEC_PRESETS = [2000, 5000, 10000, 20000];
const OPEN_IN_NIMIQ_PAY = 'https://nimpay.app/miniapps/open/nim.abapays.com';

const ngn = (v: number) => `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const nimFmt = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} NIM`;
const utf8ToHex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
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
  const [env, setEnv] = useState<'loading' | 'ready' | 'outside'>('loading');
  const [account, setAccount] = useState('');
  const [balanceLuna, setBalanceLuna] = useState<number | null>(null);

  const refreshBalance = useCallback(async (addr: string) => {
    try {
      const b = unwrap(await nimiq.current!.getBalance(addr));
      setBalanceLuna(Number(b));
    } catch { setBalanceLuna(null); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    init({ timeout: 8_000 })
      .then(async (p) => {
        nimiq.current = p;
        const accounts = unwrap(await p.listAccounts());
        if (cancelled) return;
        if (!accounts?.length) throw new Error('No Nimiq account');
        setAccount(accounts[0]);
        setEnv('ready');
        refreshBalance(accounts[0]);
      })
      .catch(() => { if (!cancelled) setEnv('outside'); });
    return () => { cancelled = true; };
  }, [refreshBalance]);

  // ── Price ──────────────────────────────────────────────────────────────────────────────────
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    const load = () => getJson<Quote>('/api/pay/nim').then(setQuote).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // ── Service + form ─────────────────────────────────────────────────────────────────────────
  const [svc, setSvc] = useState<Svc | null>(null);
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
  const [countries, setCountries] = useState<{ code: string; name: string; currency: string; prefix: string }[]>([]);
  const [country, setCountry] = useState('');
  const [products, setProducts] = useState<{ product_type_id: number; name: string }[]>([]);
  const [product, setProduct] = useState<{ product_type_id: number; name: string } | null>(null);
  const [operators, setOperators] = useState<{ operator_id: string; name: string }[]>([]);
  const [operator, setOperator] = useState<{ operator_id: string; name: string } | null>(null);
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
    return { nim: Math.ceil((usd / quote.nim_usd) * (1 + quote.buffer)), fee: serviceFee + stampDutyNgn };
  }, [bill, quote]);

  const formReady = (() => {
    if (!bill) return false;
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
      const d = await getJson<Intent & { success: boolean; message?: string }>('/api/pay/nim', { method: 'POST', body: JSON.stringify({ intent: true, payer: account, ...bill }) });
      if (!d.success) { setPhase('failed'); setMessage(d.message || 'This order could not be started.'); return; }
      intent = d;
    } catch {
      setPhase('failed'); setMessage('Network error. Nothing was charged.'); return;
    }

    if (balanceLuna !== null && balanceLuna < intent.luna) {
      setPhase('failed'); setMessage(`This costs ${nimFmt(intent.nim)} and your wallet holds ${nimFmt(balanceLuna / LUNA)}. Nothing was charged.`); return;
    }

    setPhase('signing'); setMessage(`Approve ${nimFmt(intent.nim)} in Nimiq Pay.`);
    let txHash = '';
    try {
      // No validityStartHeight: the wallet fills in the current height itself.
      const sent = unwrap(await nimiq.current.sendBasicTransactionWithData({ recipient: intent.recipient, value: intent.luna, data: utf8ToHex(intent.reference) }));
      if (typeof sent === 'string' && /^[0-9a-f]{64}$/i.test(sent)) txHash = sent.toLowerCase();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setPhase('idle');
      setMessage(/cancel|denied|reject|abort|dismiss|closed/i.test(text) ? 'Payment cancelled. Nothing was charged.' : `Nimiq Pay couldn’t send the payment: ${text}`);
      return;
    }

    setPhase('confirming'); setMessage('Payment sent. Waiting for the Nimiq network to confirm it…');
    const started = Date.now();
    while (Date.now() - started < 5 * 60_000) {
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
    setMessage('Still confirming after five minutes. Your payment is safe: the order completes, or the NIM is refunded, once the network confirms it.');
  };

  // ── Render ─────────────────────────────────────────────────────────────────────────────────
  if (env === 'loading') {
    return <Centered><Loader2 className="animate-spin text-[#E9B213]" size={28} /><p className="text-sm mt-3 opacity-70">Connecting to Nimiq Pay…</p></Centered>;
  }
  if (env === 'outside') {
    return (
      <Centered>
        <Brand />
        <h1 className="text-2xl font-black mt-6 text-center">Pay Nigerian bills with NIM</h1>
        <p className="text-sm opacity-70 mt-2 text-center max-w-sm">Airtime, data, electricity, cable TV, exam PINs, bank transfers and international top-ups. This app runs inside Nimiq Pay.</p>
        <a href={OPEN_IN_NIMIQ_PAY} className="mt-6 px-6 py-3 rounded-full bg-[#E9B213] text-[#1F2348] font-black text-sm">Open in Nimiq Pay</a>
        <a href="https://www.abapays.com" className="mt-4 text-xs underline opacity-60">Paying with stablecoins? Use abapays.com</a>
      </Centered>
    );
  }

  const busy = phase === 'ordering' || phase === 'signing' || phase === 'confirming';

  return (
    <div className="max-w-md mx-auto px-4 py-5 pb-24">
      <header className="flex items-center justify-between mb-5">
        <Brand />
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest font-bold opacity-50">Balance</p>
          <p className="text-sm font-black tabular-nums">{balanceLuna === null ? '—' : nimFmt(balanceLuna / LUNA)}</p>
        </div>
      </header>

      {quote && !quote.available && (
        <Note tone="warn">NIM payments are paused right now. Please try again shortly.</Note>
      )}

      {!svc ? (
        <>
          <h1 className="text-xl font-black mb-1">What do you want to pay?</h1>
          <p className="text-xs opacity-60 mb-4">Paid in NIM, delivered in Nigeria and 140+ countries.{quote?.nim_usd ? ` 1 NIM ≈ ${ngn(quote.nim_usd * quote.ngn_per_usd)}.` : ''}</p>
          <div className="grid grid-cols-2 gap-3">
            {SERVICES.map((s) => (
              <button key={s.id} type="button" onClick={() => { resetForm(); setSvc(s.id); setPhase('idle'); setMessage(''); }}
                className="flex flex-col items-start gap-3 p-4 rounded-2xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 text-left active:scale-[0.98] transition">
                <s.icon size={22} className="text-[#E9B213]" />
                <span className="text-sm font-black">{s.label}</span>
              </button>
            ))}
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
                <select value={provider} onChange={(e) => { setProvider(e.target.value); setVerified(null); setPlans([]); setPlan(null); }} className={input}>
                  <option value="">Choose…</option>
                  {providers.map((p) => <option key={p.serviceID} value={p.serviceID}>{p.displayName}</option>)}
                </select>
              </Field>
            )}

            {svc === 'BANK' && (
              <Field label="Bank">
                <select value={bankCode} onChange={(e) => { setBankCode(e.target.value); setVerified(null); }} className={input}>
                  <option value="">Choose…</option>
                  {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
              </Field>
            )}

            {svc === 'INTL' && (
              <>
                <Field label="Country">
                  <select value={country} onChange={(e) => { setCountry(e.target.value); setProducts([]); setProduct(null); setOperators([]); setOperator(null); setIntlPlans([]); setIntlPlan(null); }} className={input}>
                    <option value="">Choose…</option>
                    {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                </Field>
                {products.length > 0 && (
                  <Field label="Product">
                    <select value={product?.product_type_id ?? ''} onChange={(e) => { setProduct(products.find((p) => String(p.product_type_id) === e.target.value) || null); setOperators([]); setOperator(null); setIntlPlans([]); setIntlPlan(null); }} className={input}>
                      <option value="">Choose…</option>
                      {products.map((p) => <option key={p.product_type_id} value={p.product_type_id}>{p.name}</option>)}
                    </select>
                  </Field>
                )}
                {operators.length > 0 && (
                  <Field label="Operator">
                    <select value={operator?.operator_id ?? ''} onChange={(e) => { setOperator(operators.find((o) => o.operator_id === e.target.value) || null); setIntlPlans([]); setIntlPlan(null); }} className={input}>
                      <option value="">Choose…</option>
                      {operators.map((o) => <option key={o.operator_id} value={o.operator_id}>{o.name}</option>)}
                    </select>
                  </Field>
                )}
                {intlPlans.length > 0 && (
                  <Field label="Plan">
                    <select value={intlPlan?.variation_code ?? ''} onChange={(e) => setIntlPlan(intlPlans.find((p) => p.variation_code === e.target.value) || null)} className={input}>
                      <option value="">Choose…</option>
                      {intlPlans.map((p) => <option key={p.variation_code} value={p.variation_code}>{p.name}</option>)}
                    </select>
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
                <select value={plan?.variation_code ?? ''} onChange={(e) => setPlan(plans.find((p) => p.variation_code === e.target.value) || null)} className={input}>
                  <option value="">Choose…</option>
                  {plans.map((p) => <option key={p.variation_code} value={p.variation_code}>{p.name}</option>)}
                </select>
              </Field>
            )}

            {(svc === 'AIRTIME' || svc === 'ELECTRICITY' || svc === 'BANK') && (
              <Field label="Amount (₦)">
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
          </div>

          <div className="mt-5 rounded-2xl bg-white dark:bg-[#1F2348] border border-black/5 dark:border-white/10 p-4">
            <div className="flex justify-between text-xs opacity-70"><span>Bill</span><span className="tabular-nums">{bill ? ngn(bill.nairaAmount) : '—'}</span></div>
            {estimate && estimate.fee > 0 && <div className="flex justify-between text-xs opacity-70 mt-1"><span>Service fee</span><span className="tabular-nums">{ngn(estimate.fee)}</span></div>}
            <div className="flex justify-between items-baseline mt-2">
              <span className="text-sm font-black">You pay</span>
              <span className="text-xl font-black tabular-nums">{estimate ? `≈ ${nimFmt(estimate.nim)}` : '—'}</span>
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

      <footer className="mt-10 text-center text-[10px] opacity-50 space-y-1">
        <p>AbaPay by Masonode Technologies Limited · <a href="/terms" className="underline">Terms</a> · <a href="/privacy" className="underline">Privacy</a></p>
        <p>Open source · <a href="https://github.com/investorphem/AbaPay" className="underline">GitHub</a></p>
      </footer>
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

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex flex-col items-center justify-center px-6">{children}</div>;
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" width={28} height={28} className="object-contain" />
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
