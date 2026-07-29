import 'server-only';
import { getHeaders } from '@/lib/vtpass';
import {
  AIRTIME_SEED, DATA_SEED, ELECTRICITY_SEED, CABLE_SEED, EDUCATION_SEED,
  LOCAL_LOGO_BY_SERVICE_ID, type SeedService,
} from '@/lib/providerFallback';

// ⚡ LIVE VTpass PROVIDER CATALOGUE — one source of truth for every provider picker.
//
// 🔴 THE PROBLEM THIS FIXES:
// The provider name/logo for every Nigerian service was hardcoded in FOUR separate places
// (src/constants/index.ts, src/app/discos.ts, the ad-hoc `/${telecomProvider}.png` path the
// airtime button built inline, and src/lib/deai/selection.ts's copies for chat/MCP). Three
// concrete consequences, all of them real:
//
//   1. The lists advertised services this merchant account CANNOT sell. `showmax`, `spectranet`
//      and `jamb` all return `{"code":"011","content":{"errors":"Service is Not Valid"}}` from
//      VTpass. A user could pick Showmax, fill the form, pay on-chain, and only then have the
//      vend fail — money already gone, refund path engaged, for a service that never existed.
//   2. The lists were MISSING services the account can sell — `glo-sme-data` and
//      `9mobile-sme-data` are live on VTpass and were unreachable from the app entirely.
//   3. The airtime picker had no name/logo data at all: it was a bare string array
//      ["mtn","glo","etisalat","airtel"] and the UI guessed an image path per provider with an
//      onError fallback to /logo.png. Every new provider needed a code change AND a new PNG.
//
// VTpass's /services?identifier=… returns the real name, the real logo URL, and — critically —
// the real per-service `minimium_amount`/`maximum_amount`. See MIN/MAX below for why that
// matters far more than cosmetics.
//
// ⚡ CONFIRMED IDENTIFIERS (probed live against vtpass.com/api/service-categories, which returns
// exactly seven: airtime, data, education, electricity-bill, insurance, other-services,
// tv-subscription). The two that had to be discovered:
//   • DATA/INTERNET → `data`            (NOT "mobile-data"/"internet" — both 011 "Category Does not Exist")
//   • CABLE/TV      → `tv-subscription` (NOT "cable-tv" — 011 "Category Does not Exist")

export type CatalogCategory = 'airtime' | 'data' | 'electricity-bill' | 'tv-subscription' | 'education';

/** Friendly names the UI/agent use, mapped to the VTpass identifier they actually resolve to. */
export const CATEGORY_ALIASES: Record<string, CatalogCategory> = {
  airtime: 'airtime',
  telecom: 'airtime',
  data: 'data',
  internet: 'data',
  electricity: 'electricity-bill',
  'electricity-bill': 'electricity-bill',
  cable: 'tv-subscription',
  tv: 'tv-subscription',
  'tv-subscription': 'tv-subscription',
  education: 'education',
};

export interface CatalogService {
  serviceID: string;
  /** VTpass's own product name — no local rewriting, so a VTpass rename lands with no deploy. */
  displayName: string;
  /** VTpass's own product image URL (falls back to bundled artwork if VTpass omits one). */
  logo: string;
  /** VTpass's `minimium_amount` (sic — their spelling), or null when they don't publish one. */
  minAmount: number | null;
  /** VTpass's `maximum_amount`, or null when they don't publish one. */
  maxAmount: number | null;
}

export interface CatalogResult {
  category: CatalogCategory;
  providers: CatalogService[];
  /** true when this came from the offline seed or an expired cache rather than a live fetch. */
  stale: boolean;
}

const SEEDS: Record<CatalogCategory, SeedService[]> = {
  airtime: AIRTIME_SEED,
  data: DATA_SEED,
  'electricity-bill': ELECTRICITY_SEED,
  'tv-subscription': CABLE_SEED,
  education: EDUCATION_SEED,
};

// 🔴 EXCLUDED FROM THE DOMESTIC AIRTIME LIST: VTpass returns `foreign-airtime` inside the
// `airtime` category, but international airtime is a completely separate flow in this app (its
// own country → product → operator → variation picker, driven by
// /get-international-airtime-* and src/lib/deai/international.ts). Leaving it in would show
// "International Airtime" as if it were a fifth Nigerian network, and picking it would land the
// user in the domestic form with no country selected.
const DOMESTIC_EXCLUDE = new Set(['foreign-airtime']);

// VTpass's catalogue changes on the order of months, not minutes — an hour keeps repeat page
// loads instant while still picking up an added/removed service without a deploy.
const CACHE_MS = 60 * 60 * 1000;

interface CacheEntry { list: CatalogService[]; at: number }

// 🔴 The cache is deliberately NEVER evicted on failure — only overwritten on success. That is
// what makes the "VTpass is briefly unreachable" path safe: we keep serving the last-known-good
// list (marked stale) instead of blanking a picker and making a working feature look broken.
const cache = new Map<CatalogCategory, CacheEntry>();

function vtpassBaseUrl() {
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  return appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
}

/** VTpass sends amounts as strings ("100"), numbers (1000000), null, or 0-meaning-unset. */
function toAmount(raw: any): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function seedFor(category: CatalogCategory): CatalogService[] {
  return SEEDS[category].map(s => ({
    serviceID: s.serviceID,
    displayName: s.displayName,
    logo: s.logo,
    minAmount: s.minAmount,
    maxAmount: s.maxAmount,
  }));
}

function normalise(category: CatalogCategory, raw: any[]): CatalogService[] {
  return raw
    .map((s: any) => ({
      serviceID: String(s?.serviceID || '').trim(),
      displayName: String(s?.name || '').trim(),
      // Prefer VTpass's own artwork (goal: logos always match VTpass branding). Bundled artwork
      // is only a backstop for a service VTpass ships without an image.
      logo: String(s?.image || '').trim() || LOCAL_LOGO_BY_SERVICE_ID[String(s?.serviceID)] || '/logo.png',
      minAmount: toAmount(s?.minimium_amount ?? s?.minimum_amount),
      maxAmount: toAmount(s?.maximum_amount),
    }))
    .filter(s => s.serviceID && s.displayName)
    .filter(s => !(category === 'airtime' && DOMESTIC_EXCLUDE.has(s.serviceID)));
}

/**
 * The live provider list for a VTpass category.
 *
 * Never throws and never returns an empty list: fresh cache → live fetch → stale cache →
 * bundled seed. Callers can render the result unconditionally.
 */
export async function getCatalog(category: CatalogCategory): Promise<CatalogResult> {
  const cached = cache.get(category);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { category, providers: cached.list, stale: false };
  }

  try {
    const res = await fetch(`${vtpassBaseUrl()}/services?identifier=${encodeURIComponent(category)}`, {
      method: 'GET',
      headers: getHeaders(),
      cache: 'no-store',
    });
    const data = await res.json();

    // A successful catalogue read is `{ response_description: "000", content: [ … ] }`.
    // An error is `{ code: "011", content: { errors: "…" } }` — content is an OBJECT there, so
    // the Array.isArray check is what separates the two, not the HTTP status (VTpass answers
    // 200 either way).
    const raw = Array.isArray(data?.content) ? data.content : null;
    if (!raw) throw new Error(`VTpass returned no service list for "${category}": ${JSON.stringify(data?.content ?? data).slice(0, 200)}`);

    const list = normalise(category, raw);
    if (list.length === 0) throw new Error(`VTpass returned an empty service list for "${category}"`);

    cache.set(category, { list, at: Date.now() });
    return { category, providers: list, stale: false };
  } catch (err) {
    console.error(`[Catalog] Live fetch failed for "${category}":`, err);
    // Last-known-good beats blank. An expired entry is still overwhelmingly likely to be
    // correct — VTpass's catalogue barely moves — and a user mid-purchase must not be dumped
    // into an empty picker because of one failed request.
    if (cached) return { category, providers: cached.list, stale: true };
    return { category, providers: seedFor(category), stale: true };
  }
}

/** Resolve a friendly category name ("cable", "internet") to its VTpass identifier. */
export function resolveCategory(input: string): CatalogCategory | null {
  return CATEGORY_ALIASES[String(input || '').trim().toLowerCase()] || null;
}

/** One service's live entry, or null if VTpass doesn't (or no longer) offers it. */
export async function getService(category: CatalogCategory, serviceID: string): Promise<CatalogService | null> {
  const { providers } = await getCatalog(category);
  const id = String(serviceID || '').toLowerCase();
  return providers.find(p => p.serviceID.toLowerCase() === id) || null;
}

// ─── LIVE AMOUNT LIMITS ───────────────────────────────────────────────────────
//
// 🔴 THE BUG THIS FIXES: there was no per-provider ceiling anywhere. The web form used one flat
// number per SERVICE (page.tsx's dynamicMaxAmount: airtime ₦50,000, electricity ₦1,000,000) and
// the agent used another (parity.ts's maxAmountFor: airtime ₦50,000, everything else ₦500,000).
// Neither is correct for any actual provider, because VTpass's real ceiling varies per network:
//
//     mtn 200,000 · glo 100,000 · airtel 50,000 · etisalat 50,000
//
// So the flat ₦50,000 airtime cap wrongly REFUSED a perfectly valid ₦120,000 MTN top-up, while
// raising it to a flat ₦200,000 (the obvious "just use a bigger number" fix) would wrongly
// ACCEPT a ₦120,000 Airtel top-up that VTpass rejects at vend time — after the user has already
// paid on-chain. There is no single flat number that is right for all four. The same is true of
// the minimums (mtn 10 · glo 10 · airtel 50 · etisalat 5) and of electricity, where the discos
// range from ₦100 (Ikeja, Aba) to ₦2,000 (Ibadan) — against one hardcoded ₦500/₦1,000.
//
// These helpers return the LIVE per-provider bound, and null when VTpass publishes none, so the
// caller can fall back to its existing service-level default rather than accidentally treating
// "unknown" as "unlimited".

export interface AmountLimits { min: number | null; max: number | null }

export async function limitsFor(category: CatalogCategory, serviceID: string): Promise<AmountLimits> {
  const svc = await getService(category, serviceID);
  if (!svc) return { min: null, max: null };
  return { min: svc.minAmount, max: svc.maxAmount };
}

/**
 * Amount limits keyed by the AGENT's intent + provider, so chat and MCP get the same live
 * ceiling the web form does without having to know VTpass's category identifiers.
 */
export async function limitsForIntent(intent: string, provider?: string | null): Promise<AmountLimits> {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return { min: null, max: null };

  switch (intent) {
    case 'VEND_AIRTIME':
      return limitsFor('airtime', p);
    case 'VEND_DATA':
      // Chat picks a NETWORK ("mtn") for data; the VTpass service is "mtn-data".
      return limitsFor('data', p.endsWith('-data') ? p : `${p}-data`);
    case 'INTERNET':
      return limitsFor('data', p);
    case 'ELECTRICITY':
    case 'PAY_ELECTRICITY':
      return limitsFor('electricity-bill', p);
    case 'TV':
    case 'PAY_CABLE':
      return limitsFor('tv-subscription', p);
    case 'EDUCATION':
      return limitsFor('education', p);
    default:
      return { min: null, max: null };
  }
}
