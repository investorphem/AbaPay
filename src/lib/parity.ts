import 'server-only';

// ⚡ THE PARITY CONTRACT — the COMPLETE set of rules the web form enforces.
//
// Extracted rule-for-rule from the frontend's `isFormValid`. The agent is a client like any
// other: it does not get to skip validation. If it submits something the form would have
// rejected, the payment fails at vend time — or worse, half-succeeds.
//
// 🔴 If you change a rule in page.tsx, change it HERE. Both sides read from this module.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NG_PHONE_RE = /^0\d{10}$/;               // 11 digits, starts with 0

export interface FieldRequirement {
  field: string;
  label: string;
  ask: string;
  validate: (v: any) => boolean;
  error: string;
}

export const REQ: Record<string, FieldRequirement> = {
  email: {
    field: 'customer_email',
    label: 'email address',
    ask: "What's your email address? (required for international payments — your receipt goes there)",
    validate: (v: string) => EMAIL_RE.test(String(v || '')),
    error: "That doesn't look like a valid email address.",
  },
  phone: {
    // 🔴 THE BUG THIS FIXES: this used to be 'customer_phone' — a field name NOTHING else in
    // the codebase ever read or wrote. Every earlier collection point (extractEntities, the
    // network-prefix flow, the initial free-text parse) sets `intentData.phone`, so a phone
    // number given up front was silently invisible to this check — checkParity always saw it
    // as missing and asked again, even after the user had already provided it. Renamed to
    // 'phone' to match every other read/write site; grepped the entire codebase first to
    // confirm 'customer_phone' had no other reference before renaming (safe, no migration).
    field: 'phone',
    label: 'phone number',
    ask: "What's your phone number? (we send the token/receipt there)",
    validate: (v: string) => String(v || '').replace(/\D/g, '').length >= 10,
    error: 'Please give a valid phone number (at least 10 digits).',
  },
  internetAccountId: {
    field: 'internet_account_id',
    label: 'Smile account ID',
    ask: "What's your Smile account ID?",
    validate: (v: string) => String(v || '').trim().length > 0,
    error: 'Please give your Smile account ID.',
  },
};

export interface ParityCheck {
  valid: boolean;
  missing: FieldRequirement[];
  error?: string;
}

// ─── ACCOUNT NUMBER RULES (per service, per provider) ─────────────────────────
//
// The frontend enforces a DIFFERENT account format for nearly every service. The agent
// previously validated only Nigerian phone numbers, so e.g. a 6-digit "meter number" or a
// 5-digit bank account would sail straight through to VTpass and fail.

export function checkAccountNumber(intent: string, account: string, provider?: string | null): ParityCheck {
  const a = String(account || '').replace(/\s/g, '');
  const p = String(provider || '').toLowerCase();

  const fail = (error: string): ParityCheck => ({ valid: false, missing: [], error });

  switch (intent) {
    case 'VEND_AIRTIME':
      // frontend: accountNumber.length === 11 && startsWith("0")
      if (!NG_PHONE_RE.test(a)) return fail('Nigerian numbers must be 11 digits and start with 0 — e.g. 08012345678.');
      return { valid: true, missing: [] };

    case 'VEND_DATA':
    case 'INTERNET':
      // frontend: smile-direct -> account id; spectranet -> >=5; else 11-digit phone
      if (p.includes('smile')) return { valid: true, missing: [] };  // uses internetAccountId instead
      if (p.includes('spectranet')) {
        if (a.length < 5) return fail('That Spectranet account number looks too short (at least 5 characters).');
        return { valid: true, missing: [] };
      }
      if (!NG_PHONE_RE.test(a)) return fail('Nigerian numbers must be 11 digits and start with 0 — e.g. 08012345678.');
      return { valid: true, missing: [] };

    case 'ELECTRICITY':
      // frontend: accountNumber.length >= 10
      if (a.length < 10) return fail('That meter number looks too short — it should be at least 10 digits.');
      return { valid: true, missing: [] };

    case 'TV':
      // frontend: showmax -> >=11 ; others -> >=10
      if (p.includes('showmax')) {
        if (a.length < 11) return fail('Showmax needs a phone number (11 digits).');
        return { valid: true, missing: [] };
      }
      if (a.length < 10) return fail('That smartcard/IUC number looks too short — it should be at least 10 digits.');
      return { valid: true, missing: [] };

    case 'BANK_TRANSFER':
      // frontend: accountNumber.length === 10
      if (a.length !== 10) return fail('Nigerian bank account numbers are exactly 10 digits.');
      return { valid: true, missing: [] };

    case 'EDUCATION':
      // frontend: jamb -> >=10 ; others -> no account
      if (p.includes('jamb') && a.length < 10) return fail('That JAMB profile code looks too short.');
      return { valid: true, missing: [] };

    default:
      return { valid: true, missing: [] };
  }
}

// ─── VERIFIED CUSTOMER NAME ───────────────────────────────────────────────────
//
// The frontend REFUSES to submit until VTpass has returned a customer name for these
// services (`customerName !== null`). It's how the user confirms they're paying the right
// meter/smartcard/account. The agent must not skip it.

export function requiresVerifiedName(intent: string, provider?: string | null): boolean {
  const p = String(provider || '').toLowerCase();
  switch (intent) {
    case 'ELECTRICITY':   return true;
    case 'TV':            return !p.includes('showmax');   // showmax is exempt in the frontend
    case 'BANK_TRANSFER': return true;
    case 'EDUCATION':     return p.includes('jamb');       // only JAMB verifies
    default:              return false;
  }
}

// ─── VARIATIONS / PLANS ───────────────────────────────────────────────────────
//
// Which services require a plan to be chosen, and the subtle DStv/GOtv rule the agent
// completely ignored: on a "renew", no plan is needed (you're renewing the current one);
// on a "change", a plan IS required.

export function requiresVariation(intent: string, provider?: string | null, cableAction?: string | null): boolean {
  const p = String(provider || '').toLowerCase();

  switch (intent) {
    case 'VEND_DATA':
    case 'INTERNET':
      return true;

    case 'EDUCATION':
      return true;

    case 'TV':
      // frontend: dstv/gotv + 'change' -> plan required; 'renew' -> NOT required.
      //           any other provider -> plan always required.
      if (['dstv', 'gotv'].includes(p)) return cableAction === 'change';
      return true;

    default:
      return false;
  }
}

/** Does this cable provider support renew-vs-change? (DStv/GOtv only.) */
export function supportsRenew(provider?: string | null): boolean {
  return ['dstv', 'gotv'].includes(String(provider || '').toLowerCase());
}

// ─── EXTRA CONTACT FIELDS ─────────────────────────────────────────────────────

export function requiredFieldsFor(
  intent: string,
  opts: { isInternational?: boolean; provider?: string | null } = {}
): FieldRequirement[] {
  const req: FieldRequirement[] = [];
  const p = String(opts.provider || '').toLowerCase();

  if (opts.isInternational) {
    req.push(REQ.email);   // frontend hard-requires a valid email for ALL international
    return req;
  }

  switch (intent) {
    case 'VEND_AIRTIME':
      break;   // the destination phone IS the account

    case 'VEND_DATA':
    case 'INTERNET':
      // frontend: smile-direct needs an account id AND a contact phone
      if (p.includes('smile')) { req.push(REQ.internetAccountId); req.push(REQ.phone); }
      break;

    case 'ELECTRICITY':   // token delivered by SMS
    case 'TV':
    case 'BANK_TRANSFER':
    case 'EDUCATION':
      req.push(REQ.phone);
      break;
  }

  return req;
}

// ─── AMOUNT LIMITS ────────────────────────────────────────────────────────────

export function minAmountFor(intent: string): number {
  switch (intent) {
    case 'VEND_AIRTIME':  return 50;
    case 'ELECTRICITY':   return 500;
    case 'TV':            return 100;
    case 'BANK_TRANSFER': return 100;
    default:              return 100;
  }
}

export const MAX_AMOUNT_NGN = 500_000;

/**
 * @param isFixedPlan  When the user picked a fixed-price plan (a data bundle, a cable
 *                     package), the frontend SKIPS min/max entirely — the plan's price is
 *                     the price. The agent must skip it too, or it would reject a legitimate
 *                     ₦50 data bundle for being "below the ₦100 minimum".
 * @param verifiedMin  VTpass sometimes returns a provider-specific minimum (e.g. a postpaid
 *                     balance owed). The frontend uses it; so must we.
 */
export function checkAmount(
  intent: string,
  amountNgn: number,
  opts: { isFixedPlan?: boolean; verifiedMin?: number | null } = {}
): ParityCheck {
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    return { valid: false, missing: [], error: 'Please give me a valid amount.' };
  }

  if (opts.isFixedPlan) return { valid: true, missing: [] };   // plan price IS the price

  const min = Math.max(minAmountFor(intent), Number(opts.verifiedMin) || 0);

  if (amountNgn < min) {
    return { valid: false, missing: [], error: `The minimum for this service is ₦${min.toLocaleString()}.` };
  }
  if (amountNgn > MAX_AMOUNT_NGN) {
    return { valid: false, missing: [], error: `That's above the ₦${MAX_AMOUNT_NGN.toLocaleString()} per-transaction limit.` };
  }

  return { valid: true, missing: [] };
}

/**
 * ⚡ INTERNATIONAL MINIMUM — the frontend rejects anything under 1 stablecoin.
 */
export function checkIntlMinimum(foreignAmount: number, variationRate: number, exchangeRate: number): ParityCheck {
  if (!Number.isFinite(foreignAmount) || foreignAmount <= 0) {
    return { valid: false, missing: [], error: 'Please give me a valid amount.' };
  }
  const crypto = (foreignAmount * (variationRate || 1)) / exchangeRate;
  if (crypto < 1) {
    return { valid: false, missing: [], error: 'That is below our $1 minimum for international payments. Please send a little more.' };
  }
  return { valid: true, missing: [] };
}

// ─── THE FULL GATE ────────────────────────────────────────────────────────────

export function checkParity(
  intent: string,
  data: Record<string, any>,
  opts: { isInternational?: boolean } = {}
): ParityCheck {
  const provider = data.provider;

  // 1. Account number format (per service, per provider)
  if (!opts.isInternational && data.destination_account) {
    const acct = checkAccountNumber(intent, data.destination_account, provider);
    if (!acct.valid) return acct;
  }
  // International: frontend requires accountNumber.length >= 6
  if (opts.isInternational && data.destination_account) {
    if (String(data.destination_account).replace(/\s/g, '').length < 6) {
      return { valid: false, missing: [], error: 'That number looks too short.' };
    }
  }

  // 2. Verified customer name (electricity, cable, bank, JAMB)
  if (!opts.isInternational && requiresVerifiedName(intent, provider) && !data.verified_name && !data.customer_name) {
    return {
      valid: false,
      missing: [],
      error: "I couldn't verify that account — please double-check the number.",
    };
  }

  // 3. Extra contact fields
  const missing: FieldRequirement[] = [];
  for (const r of requiredFieldsFor(intent, { isInternational: opts.isInternational, provider })) {
    const val = data[r.field];
    if (!val) { missing.push(r); continue; }
    if (!r.validate(val)) return { valid: false, missing: [], error: r.error };
  }

  return { valid: missing.length === 0, missing };
}

// ─── DUPLICATE GUARD ──────────────────────────────────────────────────────────

/**
 * The frontend blocks an identical electricity payment on the same day (same meter, same
 * amount) — double-vending a token is a common and expensive user error.
 */
export async function isDuplicateElectricity(
  supabase: any,
  walletAddress: string,
  meterNumber: string,
  amountNgn: number
): Promise<boolean> {
  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const { data } = await supabase
      .from('transactions')
      .select('id')
      .ilike('wallet_address', walletAddress)
      .eq('account_number', meterNumber)
      .eq('amount_naira', amountNgn)
      .eq('service_category', 'ELECTRICITY')
      .in('status', ['SUCCESS', 'PENDING', 'PROCESSING'])
      .gte('created_at', startOfDay.toISOString())
      .limit(1);

    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;   // never block a legitimate payment because of a lookup failure
  }
}

// ─── DISPLAY ──────────────────────────────────────────────────────────────────

export function formatConversion(amountNgn: number, exchangeRate: number, tokenSymbol: string): string {
  const crypto = amountNgn / exchangeRate;
  return `₦${amountNgn.toLocaleString()} ≈ *${crypto.toFixed(4)} ${tokenSymbol}*`;
}

export function formatIntlConversion(
  foreignAmount: number,
  currency: string,
  variationRate: number,
  exchangeRate: number,
  tokenSymbol: string
): string {
  const naira = foreignAmount * (variationRate || 1);
  const crypto = naira / exchangeRate;
  return `${currency} ${foreignAmount.toLocaleString()} ≈ ₦${naira.toLocaleString(undefined, { maximumFractionDigits: 0 })} ≈ *${crypto.toFixed(4)} ${tokenSymbol}*`;
}
