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
}

export interface IntlProduct { product_type_id: string; name: string; }
export interface IntlOperator { operator_id: string; name: string; }
export interface IntlVariation {
  variation_code: string;
  name: string;
  variation_amount: string;
  fixedPrice?: string;
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
    const raw = data?.content ?? [];

    const list: IntlCountry[] = (Array.isArray(raw) ? raw : []).map((c: any) => ({
      code: c.code || c.country_code || c.id,
      name: c.name,
      currency: c.currency,
      prefix: c.prefix,
    })).filter((c: IntlCountry) => c.code && c.name);

    countryCache = { list, at: Date.now() };
    return list;
  } catch (err) {
    console.error('[Intl] fetchCountries failed:', err);
    return [];
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
