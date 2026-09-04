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

// 🔴 THE BUG THIS FIXES: /api/monnify/resolve fires validateAccount for every bank in
// parallel batches (see resolve/route.ts). Every one of those calls independently checked
// "is there a cached token?" and, on a cold start (no token yet) or right at expiry, ALL of
// them saw no valid cache at the same instant and each fired its OWN /api/v1/auth/login —
// a thundering herd of up to 8 simultaneous logins for what should be one shared token. Some
// of those got rejected/rate-limited, and the resulting 401s each triggered ANOTHER retry
// login in monnifyFetch below — compounding into the "Task timed out after 300 seconds" seen
// in production on /api/monnify/resolve, and, likely, most of the batch silently coming back
// as "no match" (validateAccount swallows any error into null) even for the correct bank.
//
// Fix: at most one login in flight at a time. Concurrent callers await the SAME promise
// instead of each starting their own.
let tokenFetchPromise: Promise<string> | null = null;

async function fetchNewToken(): Promise<string> {
  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    try {
      const apiKey = process.env.MONNIFY_API_KEY || '';
      const secretKey = process.env.MONNIFY_SECRET_KEY || '';
      const basic = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

      const res = await fetch(`${baseUrl()}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
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
    } finally {
      tokenFetchPromise = null; // next call (after this settles) is free to fetch again if needed
    }
  })();

  return tokenFetchPromise;
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  return fetchNewToken();
}

// --- 2. AUTHENTICATED FETCH (retries once on 401 with a fresh token) ---

// 🔴 ALSO PART OF THE TIMEOUT FIX ABOVE: no call into Monnify had a timeout at all, so one
// slow/hanging response (sandbox is noticeably less consistent than live) could block an
// entire resolve batch — which awaits Promise.all per batch — indefinitely. 8 seconds is
// generous for a same-region API call; a bank that hasn't answered by then is treated as no
// match, exactly like a genuine "wrong bank" response, rather than freezing the whole sweep.
//
// 🔴 THE BUG THIS FIXES: that same flat 8s applied to EVERY call, including the single,
// critical disbursement-initiate request — a real money-moving call with no batch/parallelism
// concern at all (unlike the ~25-way resolve sweep this was tuned for). Aborting it early
// meant our OWN client gave up before Monnify's sandbox (observed as noticeably slower than
// its live equivalent) had even finished processing — the request never showed up in
// Monnify's own event log, and the caller's catch-all treated the abort as "network blip,
// safe to retry later," silently parking a transfer that was never actually submitted.
// Callers that are NOT part of a large parallel batch now get a longer default.
const DEFAULT_TIMEOUT_MS = 8_000;

async function monnifyFetch(path: string, opts: RequestInit = {}, retried = false, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 && !retried) {
    tokenCache = null; // force a fresh login
    return monnifyFetch(path, opts, true, timeoutMs);
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

export interface AccountValidationRaw {
  requestSuccessful: boolean;
  responseCode: string;
  responseMessage: string;
  result: AccountValidation | null;
}

// ⚡ VERBOSE VARIANT — carries Monnify's own responseCode/responseMessage through, instead of
// collapsing every failure into a bare null. validateAccount() below is a thin wrapper kept for
// the auto-detect SWEEP (resolve/route.ts), where a null IS the expected outcome for the vast
// majority of the ~25 banks tried and the real reason genuinely doesn't matter. But for a
// SINGLE manual verify (verify/route.ts) — a real user waiting on a real answer — silently
// returning null on, say, an invalid account number format meant they saw nothing at all
// instead of Monnify's own (already human-readable) rejection message.
export async function validateAccountRaw(accountNumber: string, bankCode: string, timeoutMs?: number): Promise<AccountValidationRaw> {
  try {
    // 🔴 v1 OF THIS PATH IS DEPRECATED — Monnify now rejects it outright with "This API
    // endpoint has been deprecated and is no longer available", which every caller here
    // (validateAccount's ~25-bank auto-detect sweep, and the single manual verify) folded into
    // "no match" / "could not verify". Their changelog confirms v2 is a straight path bump —
    // same GET method, same accountNumber/bankCode query params, same response shape — nothing
    // else in this function needed to change.
    const data = await monnifyFetch(
      `/api/v2/disbursements/account/validate?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`,
      { method: 'GET' },
      false,
      timeoutMs
    );
    const requestSuccessful = !!data?.requestSuccessful && !!data?.responseBody?.accountName;
    return {
      requestSuccessful,
      responseCode: data?.responseCode ?? 'UNKNOWN',
      responseMessage: data?.responseMessage || 'Could not verify this account.',
      result: requestSuccessful ? {
        accountNumber: data.responseBody.accountNumber,
        accountName: data.responseBody.accountName,
        bankCode: data.responseBody.bankCode || bankCode,
      } : null,
    };
  } catch (e: any) {
    // A network-level failure (timeout, connection reset) — distinguishable from Monnify
    // actively rejecting the request, which callers may want to treat differently.
    return { requestSuccessful: false, responseCode: 'NETWORK_ERROR', responseMessage: e?.message || 'Could not reach Monnify.', result: null };
  }
}

export async function validateAccount(accountNumber: string, bankCode: string): Promise<AccountValidation | null> {
  const raw = await validateAccountRaw(accountNumber, bankCode);
  return raw.result; // wrong bank for this account, or a transient error — either way, no match
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

// ⚡ MONNIFY'S FULL DISBURSEMENT STATUS VOCABULARY — sourced directly from their own
// "Transaction Status Reference" docs. The code previously only recognized SUCCESS and
// FAILED as terminal outcomes; everything else (COMPLETED, REVERSED, EXPIRED,
// PENDING_AUTHORIZATION, OTP_EMAIL_DISPATCH_FAILED) silently fell into "still processing" —
// meaning a transfer that was actually done, or actually dead, or actually stuck waiting on
// a human OTP step, just sat there forever looking identical to one genuinely in flight.
export type TransferOutcome = 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'NEEDS_AUTH';

/**
 * Classifies a raw Monnify status string into one of four outcomes:
 *   SUCCESS    — SUCCESS, COMPLETED: delivered.
 *   FAILED     — FAILED, REVERSED (bounced back to OUR wallet, not the recipient),
 *                EXPIRED (never authorized within its validity window): definitively did NOT
 *                reach the recipient — the user is owed a refund.
 *   NEEDS_AUTH — PENDING_AUTHORIZATION (MFA/OTP required), OTP_EMAIL_DISPATCH_FAILED
 *                (Monnify couldn't even send the OTP email): stuck on a human step that a
 *                silent retry can never resolve — needs an operator.
 *   PROCESSING — PENDING, AWAITING_PROCESSING, IN_PROGRESS, or anything unrecognized: still
 *                genuinely in flight, check again later.
 */
export function classifyTransferStatus(status: string | undefined | null): TransferOutcome {
  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'COMPLETED') return 'SUCCESS';
  if (s === 'FAILED' || s === 'REVERSED' || s === 'EXPIRED') return 'FAILED';
  if (s === 'PENDING_AUTHORIZATION' || s === 'OTP_EMAIL_DISPATCH_FAILED') return 'NEEDS_AUTH';
  return 'PROCESSING';
}

// ⚡ DISBURSEMENT ERROR REFERENCE — verbatim from Monnify's own "Error Codes" documentation
// (their /docs/error-codes page is a JS-rendered SPA our fetch tooling couldn't execute, so
// this was transcribed directly from the source rather than guessed). Mirrors the shape of
// vend.ts's VTpass error_messages map. Keyed by whatever Monnify puts in the error/message
// field of a failed disbursement — their own docs use the full message text as the "code" for
// most of these (not a short enum), only D01–D07 and 99 are short codes.
export const MONNIFY_DISBURSEMENT_ERRORS: Record<string, string> = {
  '99': "Monnify hit an unexpected error processing this transfer — we'll re-check the status shortly.",
  D01: "Monnify couldn't process this transfer.",
  D02: "Monnify has no record of this transfer request.",
  D03: 'The account details supplied were invalid.',
  D04: "Your Moniepoint balance is too low to complete this transfer — please top it up.",
  D05: 'That transfer reference was already used — this should not normally happen.',
  D06: "This server's IP address isn't whitelisted with Monnify yet.",
  D07: 'A transfer to this exact account for this exact amount was already made in the last 2 minutes.',
  'Invalid destination account number': "The recipient's account number didn't pass validation.",
  'Dormant beneficiary account': "The recipient's account is dormant — they'll need to contact their bank.",
  'Beneficiary account name mismatch': "The account name didn't match the account number.",
  'Unknown destination bank code': "The recipient's bank code isn't recognized by Monnify.",
  'Transaction timed out while waiting for destination bank': "The recipient's bank didn't respond in time — this often resolves on its own.",
  'Invalid amount': 'The transfer amount was invalid.',
  'Delayed processing from NIP': 'The interbank network is delaying this transfer — it often still completes.',
  'Post No Credit restriction on beneficiary account': "The recipient's account can't be credited (bank-side restriction) — they'll need to contact their bank.",
  'Beneficiary bank not available': "The recipient's bank is currently unavailable.",
  'Rejected by destination institution': "The recipient's bank rejected the credit.",
  'Suspected fraud': "The recipient's account is flagged for a fraud investigation.",
  'System malfunction by destination institution': "The recipient's bank is having a system issue.",
  'Beneficiary account limit exceeded': "The recipient's account tier can't receive this amount.",
  'Sender not permitted to credit beneficiary': "The recipient's account has a restriction blocking this credit.",
  'Account number could not be validated': "The recipient's account number couldn't be validated.",
  'Supplied account number does not belong to merchant': 'The configured Moniepoint source account number is wrong — this is a setup issue, not the recipient\'s.',
};

/** Best-effort friendly text for a Monnify disbursement failure — falls back to their own
 * responseMessage/error text when we don't have a specific mapping, never a bare code.
 * ADMIN-FACING ONLY — see userFacingMonnifyError() for what's safe to show the customer. */
export function friendlyMonnifyError(codeOrMessage: string | undefined | null): string {
  if (!codeOrMessage) return 'The transfer could not be completed.';
  return MONNIFY_DISBURSEMENT_ERRORS[codeOrMessage] || codeOrMessage;
}

// 🔴 Of MONNIFY_DISBURSEMENT_ERRORS, only these are actually about the RECIPIENT's account or
// bank — safe and useful for the customer to hear ("your beneficiary's account is dormant").
// Everything else (D01/D02/D04/D05/D06/D07, '99', "Sender not permitted to credit
// beneficiary", "Supplied account number does not belong to merchant", "Suspected fraud") is
// about OUR side — our float, our reference/IP/merchant-account setup, or a
// fraud-investigation flag that shouldn't be relayed externally. A user was nearly told
// "Your Moniepoint balance is too low" for a D04 before this split existed.
const USER_SAFE_MONNIFY_ERRORS = new Set([
  'D03',
  'Invalid destination account number',
  'Dormant beneficiary account',
  'Beneficiary account name mismatch',
  'Unknown destination bank code',
  'Transaction timed out while waiting for destination bank',
  'Invalid amount',
  'Delayed processing from NIP',
  'Post No Credit restriction on beneficiary account',
  'Beneficiary bank not available',
  'Rejected by destination institution',
  'System malfunction by destination institution',
  'Beneficiary account limit exceeded',
  'Account number could not be validated',
]);

/**
 * The customer-safe counterpart to friendlyMonnifyError() — only ever returns text about the
 * recipient's own account/bank, never an internal/operational fact (our float, our setup,
 * a fraud flag). Anything not on the safe allowlist collapses to one generic, reassuring
 * line, same as VTpass's failure path already does for the user-facing side.
 */
export function userFacingMonnifyError(codeOrMessage: string | undefined | null): string {
  const key = codeOrMessage || '';
  if (USER_SAFE_MONNIFY_ERRORS.has(key)) return MONNIFY_DISBURSEMENT_ERRORS[key];
  return "This transfer couldn't be completed.";
}

/**
 * Pulls the raw failure text out of whichever Monnify response shape we're holding — the
 * synchronous initiate/status response nests it under `responseBody.transactionDescription`,
 * a webhook payload nests it under `eventData.transactionDescription` (see
 * FAILED_DISBURSEMENT's sample body), and a hard rejection may only ever have a top-level
 * `responseMessage`. Shared by both the admin-facing and user-facing formatters below so a
 * code/message is only ever looked up once.
 */
function extractMonnifyRawFailureText(raw: any): string | undefined {
  return raw?.responseBody?.transactionDescription
    || raw?.eventData?.transactionDescription
    || raw?.responseMessage
    || raw?.error
    || raw?.message
    || undefined;
}

export function extractMonnifyFailureReason(raw: any): string {
  return friendlyMonnifyError(extractMonnifyRawFailureText(raw));
}

/** Customer-safe counterpart to extractMonnifyFailureReason() — see userFacingMonnifyError()
 * for what's actually safe to relay. */
export function extractMonnifyUserFailureReason(raw: any): string {
  return userFacingMonnifyError(extractMonnifyRawFailureText(raw));
}

/**
 * D04 specifically means our own Moniepoint float is dry — every other disbursement error
 * code is about the recipient's account/bank. Detected by responseCode where present, and by
 * the description text (the code doesn't always survive into the webhook/status-check shapes,
 * but the wording "sufficient balance" does — see the FAILED_DISBURSEMENT sample in Monnify's
 * docs) so a low-float failure can trigger an immediate operator alert instead of waiting for
 * the next scheduled balance sweep.
 */
export function isInsufficientBalanceError(raw: any): boolean {
  const code = raw?.responseBody?.responseCode || raw?.responseCode;
  if (code === 'D04') return true;
  const text = String(
    raw?.responseBody?.transactionDescription || raw?.eventData?.transactionDescription || raw?.responseMessage || ''
  ).toLowerCase();
  return text.includes('sufficient balance');
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
  }, false, 20_000); // longer timeout: a single critical money-moving call, not part of a batch

  if (!data?.requestSuccessful && !data?.responseBody) {
    throw new Error(`Monnify transfer request rejected: ${data?.responseMessage || 'unknown error'}`);
  }

  const body = data.responseBody || {};
  return { status: body.status || 'PENDING', reference: body.reference || params.reference, amount: body.amount, raw: data };
}

// --- 6. TRANSFER STATUS (for the webhook-missed / reconciliation path) ---

export async function getTransferStatus(reference: string): Promise<TransferResult | null> {
  try {
    const data = await monnifyFetch(`/api/v2/disbursements/single/summary?reference=${encodeURIComponent(reference)}`, { method: 'GET' }, false, 20_000);
    if (!data?.requestSuccessful || !data?.responseBody) return null;
    const body = data.responseBody;
    return { status: body.status, reference: body.reference || reference, amount: body.amount, raw: data };
  } catch {
    return null;
  }
}

// --- 6b. WALLET BALANCE (for the admin dashboard + low-balance alerting) ---

export interface WalletBalance {
  availableBalance: number;
  ledgerBalance: number;
  accountNumber: string;
}

export async function getWalletBalance(): Promise<WalletBalance | null> {
  const accountNumber = process.env.MONNIFY_SOURCE_ACCOUNT_NUMBER || '';
  if (!accountNumber) return null;

  try {
    const data = await monnifyFetch(`/api/v2/disbursements/wallet-balance?accountNumber=${encodeURIComponent(accountNumber)}`, { method: 'GET' });
    if (!data?.requestSuccessful || !data?.responseBody) return null;
    const body = data.responseBody;
    return {
      availableBalance: Number(body.availableBalance) || 0,
      ledgerBalance: Number(body.ledgerBalance) || 0,
      accountNumber: body.accountNumber || accountNumber,
    };
  } catch (e) {
    console.error('[Monnify] getWalletBalance failed:', (e as Error).message);
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
