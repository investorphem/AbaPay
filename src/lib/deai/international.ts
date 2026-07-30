import 'server-only';
import { getHeaders } from '@/lib/vtpass';

// ⚡ INTERNATIONAL AIRTIME/DATA — live VTpass catalogue.
//
// The web app fetches countries/products/operators live from VTpass (NOT from the static
// SUPPORTED_COUNTRIES constant, which is only an initial value). The agent must use the
// SAME live catalogue, or it would claim to support countries the app doesn't — or refuse
// countries the app happily handles.

function vtpassBaseUrl() {
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  return appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
}

export interface IntlCountry {
  code: string;
  name: string;
  currency?: string;
  prefix?: string;
  /** VTpass's own flag image URL (https://vtpass.com/resources/images/flags/GH.png). */
  flag?: string;
}

export interface IntlProduct { product_type_id: string; name: string; }
export interface IntlOperator { operator_id: string; name: string; }
export interface IntlVariation {
  variation_code: string;
  name: string;
  variation_amount: string;
  fixedPrice?: string;
  // ⚡ NAIRA-EQUIVALENT PRICING — VTpass returns these on every variation, but this function
  // used to drop both. The web app reads them straight off its own raw fetch (src/app/page.tsx's
  // calculatedNairaAmount: `charged_amount` for a fixed plan when present, else
  // `variation_amount * variation_rate`) to know what a foreign-currency plan actually costs in
  // Naira — without them, nothing server-side (MCP included) can price an international plan
  // without re-trusting a client-claimed amount, which is exactly the number that decides how
  // much crypto gets charged.
  variation_rate?: string;
  charged_amount?: string;
}

// Countries change rarely; cache to avoid hammering VTpass on every chat message.
let countryCache: { list: IntlCountry[]; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

export async function fetchCountries(): Promise<IntlCountry[]> {
  if (countryCache && Date.now() - countryCache.at < CACHE_MS) return countryCache.list;

  try {
    const res = await fetch(`${vtpassBaseUrl()}/get-international-airtime-countries`, {
      method: 'GET',
      headers: getHeaders(),
    });
    const data = await res.json();

    // 🔴 THE BUG THIS FIXES: this read `data?.content ?? []` and then `Array.isArray(raw) ? raw
    // : []`. But VTpass does NOT return a bare array here — unlike every other endpoint in this
    // file, /get-international-airtime-countries nests the list one level deeper:
    //
    //   { "response_description": "000", "content": { "countries": [ {code, flag, name, …} ] } }
    //
    // `content` is an OBJECT, so Array.isArray was false on every single successful response and
    // fetchCountries returned [] every time. It never threw and never logged, so it looked
    // healthy — but resolveCountry() consequently returned null for EVERY country, and
    // capabilities.ts turned that into "I can't send airtime to Ghana — our provider doesn't
    // cover it" for all 100+ countries VTpass actually serves. International airtime was
    // unreachable from chat and MCP entirely, while the backend supported it the whole time.
    // (The web app dodged this by going through extractVtpassArray, whose last-ditch branch
    // digs nested arrays out of `content` — which is why the picker worked there and not here.)
    const content = data?.content;
    const raw = Array.isArray(content?.countries) ? content.countries
              : Array.isArray(content) ? content
              : [];

    const list: IntlCountry[] = raw.map((c: any) => ({
      code: c.code || c.country_code || c.id,
      name: c.name,
      currency: c.currency,
      prefix: c.prefix,
      flag: c.flag,
    })).filter((c: IntlCountry) => c.code && c.name);

    // Don't cache a shape we failed to understand — that would pin the empty list for 10
    // minutes and make the next (possibly fine) response irrelevant.
    if (list.length === 0) throw new Error(`Unrecognised country payload: ${JSON.stringify(content).slice(0, 200)}`);

    countryCache = { list, at: Date.now() };
    return list;
  } catch (err) {
    console.error('[Intl] fetchCountries failed:', err);
    // Last-known-good beats nothing: an expired list is still overwhelmingly likely to be right,
    // and returning [] here is what makes resolveCountry() answer "we don't cover that country"
    // about countries we definitely do cover.
    return countryCache?.list ?? [];
  }
}

export async function fetchProducts(countryCode: string): Promise<IntlProduct[]> {
  try {
    const res = await fetch(`${vtpassBaseUrl()}/get-international-airtime-product-types?code=${encodeURIComponent(countryCode)}`, {
      method: 'GET', headers: getHeaders(),
    });
    const data = await res.json();
    const raw = data?.content ?? [];
    return (Array.isArray(raw) ? raw : []).map((p: any) => ({
      product_type_id: String(p.product_type_id ?? p.id),
      name: p.name,
    })).filter((p: IntlProduct) => p.product_type_id && p.name);
  } catch (err) {
    console.error('[Intl] fetchProducts failed:', err);
    return [];
  }
}

export async function fetchOperators(countryCode: string, productTypeId: string): Promise<IntlOperator[]> {
  try {
    const res = await fetch(
      `${vtpassBaseUrl()}/get-international-airtime-operators?code=${encodeURIComponent(countryCode)}&product_type_id=${encodeURIComponent(productTypeId)}`,
      { method: 'GET', headers: getHeaders() }
    );
    const data = await res.json();
    const raw = data?.content ?? [];
    return (Array.isArray(raw) ? raw : []).map((o: any) => ({
      operator_id: String(o.operator_id ?? o.id),
      name: o.name,
    })).filter((o: IntlOperator) => o.operator_id && o.name);
  } catch (err) {
    console.error('[Intl] fetchOperators failed:', err);
    return [];
  }
}

export async function fetchIntlVariations(operatorId: string, productTypeId: string): Promise<IntlVariation[]> {
  try {
    const res = await fetch(
      `${vtpassBaseUrl()}/service-variations?serviceID=foreign-airtime&operator_id=${encodeURIComponent(operatorId)}&product_type_id=${encodeURIComponent(productTypeId)}`,
      { method: 'GET', headers: getHeaders() }
    );
    const data = await res.json();
    const raw = data?.content?.variations ?? [];
    return (Array.isArray(raw) ? raw : []).map((v: any) => ({
      variation_code: v.variation_code,
      name: v.name,
      variation_amount: String(v.variation_amount),
      fixedPrice: v.fixedPrice,
      variation_rate: v.variation_rate != null ? String(v.variation_rate) : undefined,
      charged_amount: v.charged_amount != null ? String(v.charged_amount) : undefined,
    })).filter((v: IntlVariation) => v.variation_code);
  } catch (err) {
    console.error('[Intl] fetchIntlVariations failed:', err);
    return [];
  }
}

/**
 * Resolve a country the user named in chat ("Ghana", "GH", "ghana") against the LIVE
 * VTpass catalogue. Returns null if VTpass doesn't actually serve that country — so the
 * agent tells the truth instead of promising something that would fail at vend time.
 */
export async function resolveCountry(input: string): Promise<IntlCountry | null> {
  if (!input) return null;
  const list = await fetchCountries();
  const q = input.trim().toLowerCase();

  return (
    list.find(c => c.code.toLowerCase() === q) ||
    list.find(c => c.name.toLowerCase() === q) ||
    list.find(c => c.name.toLowerCase().startsWith(q)) ||
    null
  );
}
