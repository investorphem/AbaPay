// ⚡ LAST-RESORT PROVIDER SEED — the only hardcoded provider data left in the app, and it is
// never the second-best source: it is the THIRD tier of a fresh cache → live fetch → stale
// cache → this seed chain, only reached on a cold start during a genuine provider outage. See
// vtpassCatalog.ts's getCatalog() (VTpass) and monnify.ts's getBanks() (Monnify/Moniepoint) —
// both implement the identical chain, just against different providers.
//
// Every provider picker (web app, chat, MCP, admin) is now sourced LIVE from VTpass's
// `/services?identifier=…` catalogue via src/lib/vtpassCatalog.ts. This file exists purely so
// that a cold start during a VTpass outage degrades to something usable instead of an empty
// picker — see vtpassCatalog.ts's fallback chain (fresh cache → stale cache → this seed).
//
// 🔴 WHY THE LOGOS HERE ARE LOCAL AND NOT VTpass URLs:
// this seed is only ever reached when VTpass is unreachable. Pointing it at
// https://vtpass.com/resources/products/... would mean the one code path that exists for "VTpass
// is down" renders 12 broken images, which is the exact failure it's supposed to absorb. The
// live path uses VTpass's own image URLs; this offline path uses the bundled copies.
//
// The serviceIDs, names and amount limits below are a verbatim snapshot of the LIVE catalogue
// (vtpass.com/api/services, live merchant account) so even the degraded state tells the truth.
// It is a snapshot, not a source of truth: if VTpass adds or drops a service, the live fetch
// reflects it with no deploy and this file simply goes further out of date without breaking.

export interface SeedService {
  serviceID: string;
  displayName: string;
  logo: string;
  minAmount: number | null;
  maxAmount: number | null;
}

// 🔴 NOTE ON WHAT IS *NOT* HERE: the previous hardcoded lists advertised three services this
// merchant account cannot actually sell — `showmax` (cable), `spectranet` (internet) and `jamb`
// (education). All three return `{"code":"011","content":{"errors":"Service is Not Valid"}}` from
// both /services and /service-variations. A user could pick Showmax, fill in the whole form and
// only discover at vend time — after paying on-chain — that it was never purchasable. Sourcing
// the list live removes them automatically, and they are deliberately absent from this seed too.

export const AIRTIME_SEED: SeedService[] = [
  { serviceID: 'mtn',      displayName: 'MTN Airtime VTU',            logo: '/mtn.png',     minAmount: 10, maxAmount: 200000 },
  { serviceID: 'glo',      displayName: 'GLO Airtime VTU',            logo: '/glo.png',     minAmount: 10, maxAmount: 100000 },
  { serviceID: 'airtel',   displayName: 'Airtel Airtime VTU',         logo: '/airtel.png',  minAmount: 50, maxAmount: 50000 },
  { serviceID: 'etisalat', displayName: 'T2 (9mobile) Airtime VTU',   logo: '/9mobile.png', minAmount: 5,  maxAmount: 50000 },
];

export const DATA_SEED: SeedService[] = [
  { serviceID: 'mtn-data',         displayName: 'MTN Data',              logo: '/mtn.png',     minAmount: 1,   maxAmount: 1000000 },
  { serviceID: 'glo-data',         displayName: 'GLO Data',              logo: '/glo.png',     minAmount: 1,   maxAmount: 200000 },
  { serviceID: 'airtel-data',      displayName: 'Airtel Data',           logo: '/airtel.png',  minAmount: 1,   maxAmount: 1000000 },
  { serviceID: 'etisalat-data',    displayName: 'T2 (9mobile) Data',     logo: '/9mobile.png', minAmount: 1,   maxAmount: 1000000 },
  { serviceID: 'glo-sme-data',     displayName: 'GLO Data (Best Value)', logo: '/glo.png',     minAmount: 1,   maxAmount: 1000000 },
  { serviceID: '9mobile-sme-data', displayName: '9mobile SME Data',      logo: '/9mobile.png', minAmount: 1,   maxAmount: 100000 },
  { serviceID: 'smile-direct',     displayName: 'Smile Payment',         logo: '/smile.png',   minAmount: 100, maxAmount: 150000 },
];

export const ELECTRICITY_SEED: SeedService[] = [
  { serviceID: 'ikeja-electric',        displayName: 'Ikeja Electric Payment - IKEDC',                    logo: '/ikeja.png',  minAmount: 100,  maxAmount: 1000000 },
  { serviceID: 'eko-electric',          displayName: 'Eko Electric Payment - EKEDC',                      logo: '/eko.png',    minAmount: 1000, maxAmount: 100000 },
  { serviceID: 'abuja-electric',        displayName: 'Abuja Electricity Distribution Company- AEDC',      logo: '/abuja.png',  minAmount: 900,  maxAmount: 500000 },
  { serviceID: 'kano-electric',         displayName: 'KEDCO - Kano Electric',                             logo: '/kano.png',   minAmount: 500,  maxAmount: 500000 },
  { serviceID: 'portharcourt-electric', displayName: 'PHED - Port Harcourt Electric',                     logo: '/phed.png',   minAmount: 200,  maxAmount: 10000000 },
  { serviceID: 'jos-electric',          displayName: 'Jos Electric - JED',                                logo: '/jos.png',    minAmount: 1000, maxAmount: 500000 },
  { serviceID: 'kaduna-electric',       displayName: 'Kaduna Electric - KAEDCO',                          logo: '/kaduna.png', minAmount: 1100, maxAmount: 100000 },
  { serviceID: 'enugu-electric',        displayName: 'Enugu Electric - EEDC',                             logo: '/enugu.png',  minAmount: 1000, maxAmount: 500000 },
  { serviceID: 'ibadan-electric',       displayName: 'IBEDC - Ibadan Electricity Distribution Company',   logo: '/ibadan.png', minAmount: 2000, maxAmount: 500000 },
  { serviceID: 'benin-electric',        displayName: 'Benin Electricity - BEDC',                          logo: '/benin.png',  minAmount: 500,  maxAmount: 500000 },
  { serviceID: 'aba-electric',          displayName: 'Aba Electric Payment - APLE',                       logo: '/aba.png',    minAmount: 100,  maxAmount: 400000 },
  { serviceID: 'yola-electric',         displayName: 'Yola Electric Disco Payment - YEDC',                logo: '/yola.png',   minAmount: 500,  maxAmount: 500000 },
];

export const CABLE_SEED: SeedService[] = [
  { serviceID: 'dstv',      displayName: 'DSTV Subscription',      logo: '/dstv.png',      minAmount: 1,  maxAmount: 500000 },
  { serviceID: 'gotv',      displayName: 'Gotv Payment',           logo: '/gotv.png',      minAmount: 1,  maxAmount: 500000 },
  { serviceID: 'startimes', displayName: 'Startimes Subscription', logo: '/startimes.png', minAmount: 50, maxAmount: 200000 },
];

export const EDUCATION_SEED: SeedService[] = [
  { serviceID: 'waec',              displayName: 'WAEC Result Checker PIN', logo: '/waec.png', minAmount: 10,   maxAmount: 1000000 },
  { serviceID: 'waec-registration', displayName: 'WAEC Registration PIN',   logo: '/waec.png', minAmount: null, maxAmount: null },
];

export interface SeedBank {
  code: string; // CBN bank code, e.g. "044" (Access), "50515" (Moniepoint MFB)
  name: string;
}

// Only reached if Monnify's /api/v1/banks has never once succeeded since this instance's cold
// start (see monnify.ts's getBanks() — same fresh/live/stale/seed chain as the VTpass catalogue
// above). Not the full ~30-bank Monnify list — just enough that account auto-detect still works
// for the large majority of users during a genuine outage.
export const BANK_SEED: SeedBank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '063', name: 'Access Bank (Diamond)' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda Microfinance Bank' },
  { code: '50515', name: 'Moniepoint Microfinance Bank' },
  { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

// 🔴 Local artwork for the handful of serviceIDs where VTpass's own image is the right one to
// show live but we still need something bundled for the offline path. Keyed by serviceID so a
// newly-added VTpass service simply has no entry and falls back to /logo.png, rather than the
// old `/${provider}.png` string-building that guessed a path and relied on an onError handler.
export const LOCAL_LOGO_BY_SERVICE_ID: Record<string, string> = Object.fromEntries(
  [...AIRTIME_SEED, ...DATA_SEED, ...ELECTRICITY_SEED, ...CABLE_SEED, ...EDUCATION_SEED]
    .map(s => [s.serviceID, s.logo])
);

/**
 * The logo to show for a completed transaction — receipts (email, modal) and the history list.
 *
 * 🔴 DELIBERATELY THE BUNDLED ARTWORK, NOT VTpass'S URL, even though the live pickers use
 * VTpass's own images. A receipt is read long after the payment, often months later and (for
 * email) by a client that fetches images through a proxy: pointing it at
 * vtpass.com/resources/products/... makes every historical receipt depend on a third party
 * still hosting that exact file. The bundled copy is served from our own domain and can't rot.
 *
 * Matching is forgiving because the field it's given varies by caller — `service_id` is the
 * canonical lowercase id ('ibadan-electric'), but `network` holds an uppercased variant
 * ('IBADAN-ELECTRIC'), and old cached history rows have neither. Anything unrecognised falls
 * back to the AbaPay mark rather than a broken image.
 *
 * `absolute` prefixes the app origin — required for email, where a root-relative `/ibadan.png`
 * has no origin to resolve against.
 */
export function logoForServiceId(serviceId: string | null | undefined, absolute = false): string {
  const key = String(serviceId || '').trim().toLowerCase();
  const path = LOCAL_LOGO_BY_SERVICE_ID[key] || '/logo.png';
  if (!absolute) return path;
  const origin = (process.env.NEXT_PUBLIC_APP_URL || 'https://abapays.com').replace(/\/$/, '');
  return `${origin}${path}`;
}
