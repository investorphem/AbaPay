import 'server-only'; // SECURITY: Monnify (Moniepoint's API product) keys never leak to the frontend
import crypto from 'crypto';
import { BANK_SEED } from '@/lib/providerFallback';

// ⚡ MONIEPOINT / MONNIFY CLIENT ⚡
//
// The user's actual bank account lives at Moniepoint Microfinance Bank. Moniepoint doesn't
// expose its own separate developer API — the programmatic surface for that account (name
// enquiry, disbursements) is Monnify, Moniepoint Inc.'s own API product (same company,
// reached from the "Developers" tab of the Moniepoint business dashboard).
//
// This client owns exactly the same three responsibilities src/lib/vtpass.js owns for
// VTpass: auth headers/tokens, base-URL environment switching, and raw provider calls.
// Business logic (DB writes, refunds, receipts) lives in src/lib/monnifyVend.ts, mirroring
// the vtpass.js / vend.ts split.

function baseUrl(): string {
  // ⚡ MONNIFY_MODE is deliberately its OWN switch, independent of NEXT_PUBLIC_APP_MODE (which
  // governs VTpass). The two providers get set up, tested and rotated to live on completely
  // different timelines — forcing them to share one switch would mean testing Monnify sandbox
  // credentials requires dropping VTpass to sandbox too (breaking real production bill
  // payments), or testing Monnify live-only with no safe way to try it first. Falls back to
  // NEXT_PUBLIC_APP_MODE when unset, so an install that never sets MONNIFY_MODE keeps the
  // simpler single-switch behaviour.
  const mode = process.env.MONNIFY_MODE || process.env.NEXT_PUBLIC_APP_MODE || 'sandbox';
  return mode === 'live' ? 'https://api.monnify.com' : 'https://sandbox.monnify.com';
}

// --- 1. OAUTH2 TOKEN (Basic login -> Bearer token, cached until near-expiry) ---

let tokenCache: { token: string; expiresAt: number } | null = null;

async function fetchNewToken(): Promise<string> {
  const apiKey = process.env.MONNIFY_API_KEY || '';
  const secretKey = process.env.MONNIFY_SECRET_KEY || '';
  const basic = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  const res = await fetch(`${baseUrl()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json();

  if (!data?.requestSuccessful || !data?.responseBody?.accessToken) {
    throw new Error(`Monnify auth failed: ${data?.responseMessage || res.status}`);
  }

  // expiresIn is seconds (Monnify tokens run ~1hr) — refresh 90s early to avoid a
  // request racing an expiry mid-flight.
  const expiresInMs = (Number(data.responseBody.expiresIn) || 3600) * 1000;
  tokenCache = { token: data.responseBody.accessToken, expiresAt: Date.now() + expiresInMs - 90_000 };
  return tokenCache.token;
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  return fetchNewToken();
}

// --- 2. AUTHENTICATED FETCH (retries once on 401 with a fresh token) ---

async function monnifyFetch(path: string, opts: RequestInit = {}, retried = false): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  if (res.status === 401 && !retried) {
    tokenCache = null; // force a fresh login
    return monnifyFetch(path, opts, true);
  }

  return res.json();
}

// --- 3. BANK LIST ---
//
// Same fresh-cache → live-fetch → stale-cache → seed chain as vtpassCatalog.ts's getCatalog()
// — no reason for the bank list to be architecturally weaker just because it has one entry
// instead of five categories. The cache is deliberately never evicted on a failed fetch: a
// brief Monnify blip keeps serving the last-known-good full bank list (marked stale) instead
// of collapsing to the ~22-bank seed, exactly like a VTpass blip does for airtime/electricity.

export interface MonnifyBank {
  code: string; // CBN 3-6 digit bank code, e.g. "044" (Access), "50515" (Moniepoint MFB)
  name: string;
}

export interface BankListResult {
  banks: MonnifyBank[];
  /** true when this came from the offline seed or an expired cache rather than a live fetch. */
  stale: boolean;
}

const BANK_CACHE_MS = 6 * 60 * 60 * 1000; // Monnify's bank list changes on the order of months
let bankCache: { banks: MonnifyBank[]; at: number } | null = null;

function seedBanks(): MonnifyBank[] {
  return BANK_SEED.map(b => ({ code: b.code, name: b.name }));
}

export async function getBanks(): Promise<BankListResult> {
  if (bankCache && Date.now() - bankCache.at < BANK_CACHE_MS) {
    return { banks: bankCache.banks, stale: false };
  }

  try {
    const data = await monnifyFetch('/api/v1/banks', { method: 'GET' });
    const list = data?.responseBody;
    if (!data?.requestSuccessful || !Array.isArray(list) || list.length === 0) throw new Error('Empty bank list');

    const banks: MonnifyBank[] = list
      .map((b: any) => ({ code: String(b.code), name: String(b.name) }))
      .sort((a: MonnifyBank, b: MonnifyBank) => a.name.localeCompare(b.name));

    bankCache = { banks, at: Date.now() };
    return { banks, stale: false };
  } catch (e) {
    console.error('[Monnify] getBanks live fetch failed:', (e as Error).message);
    // Last-known-good beats blank, exactly as vtpassCatalog.ts's getCatalog() reasons: an
    // expired entry is still overwhelmingly likely to be correct (bank lists barely move), and
    // a user mid-transfer must not be dumped into a stunted picker over one failed request.
    if (bankCache) return { banks: bankCache.banks, stale: true };
    return { banks: seedBanks(), stale: true };
  }
}

// --- 4. NAME ENQUIRY (account number + bank code -> account name) ---

export interface AccountValidation {
  accountNumber: string;
  accountName: string;
  bankCode: string;
}

export async function validateAccount(accountNumber: string, bankCode: string): Promise<AccountValidation | null> {
  try {
    const data = await monnifyFetch(
      `/api/v1/disbursements/account/validate?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`,
      { method: 'GET' }
    );
    if (!data?.requestSuccessful || !data?.responseBody?.accountName) return null;
    return {
      accountNumber: data.responseBody.accountNumber,
      accountName: data.responseBody.accountName,
      bankCode: data.responseBody.bankCode || bankCode,
    };
  } catch {
    return null; // wrong bank for this account, or a transient error — either way, no match
  }
}

// --- 5. SINGLE TRANSFER (the actual payout) ---

export interface InitiateTransferParams {
  amount: number;
  reference: string; // our vtRequestId-equivalent — used to look the row back up on webhook
  narration: string;
  destinationBankCode: string;
  destinationAccountNumber: string;
  destinationAccountName: string;
}

export interface TransferResult {
  status: 'SUCCESS' | 'PENDING' | 'PENDING_AUTHORIZATION' | 'FAILED' | string;
  reference: string;
  amount?: number;
  raw: any;
}

export async function initiateTransfer(params: InitiateTransferParams): Promise<TransferResult> {
  const sourceAccountNumber = process.env.MONNIFY_SOURCE_ACCOUNT_NUMBER || '';

  const data = await monnifyFetch('/api/v2/disbursements/single', {
    method: 'POST',
    body: JSON.stringify({
      amount: params.amount,
      reference: params.reference,
      narration: params.narration,
      destinationBankCode: params.destinationBankCode,
      destinationAccountNumber: params.destinationAccountNumber,
      destinationAccountName: params.destinationAccountName,
      currency: 'NGN',
      sourceAccountNumber,
      async: true, // don't block on Monnify's own processing — the webhook (or the
                   // reconcile sweep, if the webhook never arrives) finalizes the row
    }),
  });

  if (!data?.requestSuccessful && !data?.responseBody) {
    throw new Error(`Monnify transfer request rejected: ${data?.responseMessage || 'unknown error'}`);
  }

  const body = data.responseBody || {};
  return { status: body.status || 'PENDING', reference: body.reference || params.reference, amount: body.amount, raw: data };
}

// --- 6. TRANSFER STATUS (for the webhook-missed / reconciliation path) ---

export async function getTransferStatus(reference: string): Promise<TransferResult | null> {
  try {
    const data = await monnifyFetch(`/api/v2/disbursements/single/summary?reference=${encodeURIComponent(reference)}`, { method: 'GET' });
    if (!data?.requestSuccessful || !data?.responseBody) return null;
    const body = data.responseBody;
    return { status: body.status, reference: body.reference || reference, amount: body.amount, raw: data };
  } catch {
    return null;
  }
}

// --- 7. WEBHOOK SIGNATURE VERIFICATION ---
//
// Monnify signs every webhook body with HMAC-SHA512, keyed with the secret key, in the
// `monnify-signature` header. Unauthenticated webhook payloads must never be trusted —
// this is the same "confirm, don't trust the push" posture src/app/api/webhook/vtpass
// already takes (there it re-queries VTpass; here the signature check plays that role,
// and the caller should STILL treat the payload as advisory and re-fetch status when
// in doubt — see src/lib/monnifyVend.ts).

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const secretKey = process.env.MONNIFY_SECRET_KEY || '';
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
