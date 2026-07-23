import 'server-only';
import {
  CABLE_PROVIDERS_LIST,
  TELECOM_PROVIDERS,
  INTERNET_PROVIDERS,
  EDUCATION_PROVIDERS,
} from '@/constants';
import { ELECTRICITY_DISCOS } from '@/app/discos';
import { fetchDataVariations } from '@/lib/deai/services';
import { categorizeDataPlan } from '@/lib/dataCategories';
import { getHeaders } from '@/lib/vtpass';

// ⚡ SELECTION ENGINE — the chat equivalent of the web app's dropdowns.
//
// 🔴 THE GAP THIS FILLS:
// The agent previously *asked* "which disco?" but never LISTED them. A user who didn't
// already know the exact VTpass service id ("ibadan-electric") was stuck. And it never
// listed data plans, cable packages, or education products at all — so those flows could
// never actually complete in chat.
//
// Everything here is sourced from the SAME constants and the SAME live VTpass endpoints the
// web app uses, so the chat and the form can never offer different options.

export interface Option {
  id: string;        // the value we actually send to VTpass
  label: string;     // what the user sees
  price?: number;    // for variations
}

/** Numbered list, ready to paste into a chat message. */
export function renderOptions(options: Option[], opts: { showPrice?: boolean } = {}): string {
  return options
    .map((o, i) => {
      const price = opts.showPrice && o.price ? ` — *₦${o.price.toLocaleString()}*` : '';
      return `*${i + 1}.* ${o.label}${price}`;
    })
    .join('\n');
}

// ─── PAGINATION (for long variation lists — cable packages, data plans) ──────
//
// 🔴 THE PROBLEM THIS FIXES: DStv alone has ~40 packages. Dumping every one as a single
// numbered wall of text in a chat window is unreadable — the user has to scroll through all
// 40 just to find the one they want. Groups of PAGE_SIZE, with "next" to see more, matches
// how a real person would want to browse a long list in a chat.

export const VARIATION_PAGE_SIZE = 8;

export interface OptionsPage {
  text: string;        // the rendered list for THIS page only, numbered 1..N locally
  hasMore: boolean;     // is there a next page?
  totalPages: number;
  page: number;         // the page actually rendered (clamped to a valid range)
}

/** Renders ONE page of a (possibly long) option list, numbered locally (1..pageSize). */
export function renderOptionsPage(
  options: Option[],
  page: number,
  opts: { showPrice?: boolean; pageSize?: number } = {},
): OptionsPage {
  const pageSize = opts.pageSize || VARIATION_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(options.length / pageSize));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = clampedPage * pageSize;
  const slice = options.slice(start, start + pageSize);

  const text = slice
    .map((o, i) => {
      const price = opts.showPrice && o.price ? ` — *₦${o.price.toLocaleString()}*` : '';
      return `*${i + 1}.* ${o.label}${price}`;
    })
    .join('\n');

  return { text, hasMore: clampedPage < totalPages - 1, totalPages, page: clampedPage };
}

/** Does this look like a request to see the next page, rather than an option pick? */
export function isNextPageRequest(input: string): boolean {
  return /^(next|more|show\s*more|next\s*page|see\s*more)\b/i.test(String(input || '').trim());
}

/**
 * Match a reply against ONE PAGE of a long option list: a local number (1..pageSize) maps to
 * the correct absolute item on that page; a name/id still matches across the FULL list
 * regardless of which page is showing, since a user who already knows the exact package name
 * shouldn't have to page through to find it.
 */
export function matchPagedOption(input: string, allOptions: Option[], page: number, pageSize = VARIATION_PAGE_SIZE): Option | null {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return null;

  const n = parseInt(q, 10);
  if (Number.isInteger(n) && n >= 1 && n <= pageSize) {
    const absoluteIndex = page * pageSize + (n - 1);
    if (absoluteIndex < allOptions.length) return allOptions[absoluteIndex];
    return null; // e.g. "8" on the final, partially-filled page — no item there
  }

  // Not a number this page recognizes — try a full-list name/id match (matchProvider's
  // fuzzy logic), but WITHOUT its own number-as-index behavior (that would silently pick
  // the wrong item using the FULL list's absolute numbering instead of this page's local
  // numbering, which is exactly the ambiguity pagination exists to avoid).
  return (
    allOptions.find(o => o.id.toLowerCase() === q) ||
    allOptions.find(o => o.label.toLowerCase() === q) ||
    allOptions.find(o => o.label.toLowerCase().includes(q)) ||
    null
  );
}

// ─── PROVIDERS ───────────────────────────────────────────────────────────────

export function electricityDiscos(): Option[] {
  return ELECTRICITY_DISCOS.map((d: any) => ({ id: d.serviceID, label: d.displayName }));
}

export function telecomNetworks(): Option[] {
  const pretty: Record<string, string> = { mtn: 'MTN', glo: 'Glo', airtel: 'Airtel', etisalat: '9mobile' };
  return TELECOM_PROVIDERS.map((p: string) => ({ id: p, label: pretty[p] || p.toUpperCase() }));
}

export function cableProviders(): Option[] {
  return (CABLE_PROVIDERS_LIST as any[]).map((c) => ({
    id: c.id || c.serviceID || c,
    label: c.name || c.displayName || String(c).toUpperCase(),
  }));
}

export function internetProviders(): Option[] {
  return (INTERNET_PROVIDERS as any[]).map((p) => ({
    id: p.id || p.serviceID || p,
    label: p.name || p.displayName || String(p).toUpperCase(),
  }));
}

export function educationProviders(): Option[] {
  return (EDUCATION_PROVIDERS as any[]).map((e) => ({
    id: e.id || e.serviceID || e,
    label: e.name || e.displayName || String(e).toUpperCase(),
  }));
}

/**
 * The provider list for a given intent — the chat equivalent of the frontend's provider dropdown.
 */
export function providersFor(intent: string): { options: Option[]; prompt: string } | null {
  switch (intent) {
    case 'ELECTRICITY':
      return { options: electricityDiscos(), prompt: '⚡ *Which electricity provider?*' };
    case 'VEND_AIRTIME':
      return { options: telecomNetworks(), prompt: '📱 *Which network?*' };
    case 'VEND_DATA':
      return { options: telecomNetworks(), prompt: '🌐 *Which network?*' };
    case 'TV':
      return { options: cableProviders(), prompt: '📺 *Which cable provider?*' };
    case 'INTERNET':
      return { options: internetProviders(), prompt: '🌐 *Which internet provider?*' };
    case 'EDUCATION':
      return { options: educationProviders(), prompt: '🎓 *Which exam body?*' };
    default:
      return null;
  }
}

/**
 * Resolve free text ("ibedc", "Ibadan", "3") against a provider list.
 * Users type all sorts of things — this accepts a number, an id, or a fuzzy name.
 */
export function matchProvider(input: string, options: Option[]): Option | null {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return null;

  // A number from the list we just showed them.
  const n = parseInt(q, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];

  return (
    options.find(o => o.id.toLowerCase() === q) ||
    options.find(o => o.label.toLowerCase() === q) ||
    options.find(o => o.label.toLowerCase().includes(q)) ||
    options.find(o => o.id.toLowerCase().includes(q)) ||
    // Common shorthands users actually type (IBEDC = Ibadan, EKEDC = Eko, etc.)
    options.find(o => {
      const shorthand = o.id.split('-')[0];       // "ibadan-electric" -> "ibadan"
      return q.includes(shorthand) || shorthand.includes(q.replace(/edc$/, ''));
    }) ||
    null
  );
}

// ─── VARIATIONS (plans / packages / products) ────────────────────────────────

function vtpassBaseUrl() {
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  return appMode === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
}

/**
 * Live variations for any VTpass service — data plans, cable packages, education products.
 * The web app shows these in a dropdown; the agent must be able to list them too, or those
 * flows simply cannot complete in chat.
 */
export async function fetchVariations(serviceID: string): Promise<Option[]> {
  try {
    const res = await fetch(`${vtpassBaseUrl()}/service-variations?serviceID=${encodeURIComponent(serviceID)}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    const data = await res.json();
    const variations = data?.content?.variations;
    if (!Array.isArray(variations)) return [];

    return variations
      .map((v: any) => ({
        id: v.variation_code,
        label: v.name,
        price: Number(v.variation_amount),
      }))
      .filter((v: Option) => v.id && v.label);
  } catch (err) {
    console.error('[Selection] fetchVariations failed:', err);
    return [];
  }
}

/**
 * Does this service need the user to pick a variation (plan/package), or is it
 * free-amount (like airtime and prepaid electricity)?
 */
export function needsVariation(intent: string, provider?: string | null): boolean {
  switch (intent) {
    case 'VEND_DATA':
    case 'INTERNET':
    case 'EDUCATION':
      return true;
    case 'TV':
      return true;   // cable packages
    case 'VEND_AIRTIME':
    case 'ELECTRICITY':
      return false;  // free amount
    default:
      return false;
  }
}

/**
 * The serviceID to fetch variations for, given an intent + provider.
 */
export function variationServiceId(intent: string, provider: string): string {
  switch (intent) {
    case 'VEND_DATA':
      return `${provider.toLowerCase()}-data`;
    case 'TV':
    case 'INTERNET':
    case 'EDUCATION':
      return provider.toLowerCase();
    default:
      return provider.toLowerCase();
  }
}

/**
 * Match a user's reply against a variation list (number, code, or fuzzy name).
 */
export function matchVariation(input: string, options: Option[]): Option | null {
  return matchProvider(input, options); // same resolution logic
}

// ─── DATA PLAN GROUPING (frontend parity) ────────────────────────────────────
//
// 🔴 WHY THIS MATTERS: MTN alone returns ~50 data plans. Dumping them as one flat numbered
// list is unusable in a chat window — the user scrolls through a wall of text.
//
// The web app groups them into tabs (Daily, Weekly, Monthly, SME, Broadband…) using
// categorizeDataPlan(). The agent now uses THE SAME FUNCTION, so the chat and the form can
// never group plans differently.

// The order the web app presents categories in (DataVariationsUI defaults to "Daily").
const CATEGORY_ORDER = [
  'Daily',
  'Weekly',
  'Monthly',
  'SME Data',
  'Broadband',
  'Annual',
  'Social / Special',
  'Voice',
  'Other',
];

export interface PlanGroup {
  category: string;
  plans: Option[];
}

/**
 * Group data plans exactly as the web app does, sorted cheapest-first within each group
 * (mirrors DataVariationsUI's sort).
 */
export function groupDataPlans(options: Option[]): PlanGroup[] {
  const groups: Record<string, Option[]> = {};

  for (const plan of options) {
    const category = categorizeDataPlan(plan.label, plan.id);
    if (!groups[category]) groups[category] = [];
    groups[category].push(plan);
  }

  // Cheapest first within each category — same as the form.
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => (a.price || 0) - (b.price || 0));
  }

  // Present in the same order the web app uses; anything unexpected goes last.
  const ordered = CATEGORY_ORDER.filter(c => groups[c]?.length).map(c => ({ category: c, plans: groups[c] }));
  const extras = Object.keys(groups)
    .filter(c => !CATEGORY_ORDER.includes(c))
    .map(c => ({ category: c, plans: groups[c] }));

  return [...ordered, ...extras];
}

/** The category menu — step 1 of picking a data plan. */
export function renderCategoryMenu(groups: PlanGroup[]): string {
  return groups
    .map((g, i) => `*${i + 1}.* ${g.category} _(${g.plans.length} plan${g.plans.length === 1 ? '' : 's'})_`)
    .join('\n');
}

/** Match a reply against the category list (number or fuzzy name). */
export function matchCategory(input: string, groups: PlanGroup[]): PlanGroup | null {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return null;

  const n = parseInt(q, 10);
  if (Number.isInteger(n) && n >= 1 && n <= groups.length) return groups[n - 1];

  return (
    groups.find(g => g.category.toLowerCase() === q) ||
    groups.find(g => g.category.toLowerCase().includes(q)) ||
    // Users type "weekend" or "night" — those live in Daily (see categorizeDataPlan).
    (['weekend', 'night', '1 day', 'day'].some(k => q.includes(k)) ? groups.find(g => g.category === 'Daily') : null) ||
    null
  );
}
