import 'server-only';
import { metric } from '@/lib/log';

// ⚡ THE NIM RAIL'S CHAIN READER — nim.abapays.com, the Nimiq Pay mini app.
//
// Nimiq is not an EVM chain, so none of the vault machinery applies: there is no contract and no
// PaymentReceived event. A NIM payment is a plain basic transaction from the payer to AbaPay's
// treasury address (NIMIQ_TREASURY_ADDRESS), carrying the intent's reference in its recipient
// data. Proof is therefore read straight from the transaction, the same rule /api/pay follows for
// the vault: every EXPECTED value comes from the server's intent row, never from the request.
//
//   • to            must be the treasury (compared in canonical form, spaces stripped)
//   • value         must be at least the luna the intent priced (1 NIM = 100,000 luna)
//   • recipientData must decode to the intent's reference, so a payment can only settle the
//                   intent it was made for, and an unrelated transfer to the treasury can't
//   • executionResult must be true, and the transaction must have enough confirmations
//
// The server never holds a Nimiq private key. Refunds are sent by the operator from the
// treasury wallet and only VERIFIED here (verifyNimRefund).

export const LUNA_PER_NIM = 100_000;

/** Albatross JSON-RPC. Public by default; set NIMIQ_RPC_URL to a private node in production. */
const RPC_URL = process.env.NIMIQ_RPC_URL || 'https://rpc.nimiqwatch.com';
/** Albatross mainnet's network id, as getTransactionByHash reports it. */
const MAINNET_NETWORK_ID = 24;
/** Micro blocks arrive about once a second; this is roughly ten seconds of depth. */
export const MIN_CONFIRMATIONS = Number(process.env.NIMIQ_MIN_CONFIRMATIONS || 10);

// ── Addresses ──────────────────────────────────────────────────────────────────────────────

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'; // Nimiq's base32: no I, O, W, Z

/** "NQ07 0000 …" → "NQ070000…". Upper-cases and strips spaces. */
export function canonicalNimAddress(addr: string): string {
  return String(addr || '').replace(/\s+/g, '').toUpperCase();
}

/** "NQ070000…" → "NQ07 0000 0000 …", the form wallets display. */
export function formatNimAddress(addr: string): string {
  return canonicalNimAddress(addr).replace(/(.{4})(?=.)/g, '$1 ');
}

/** A well-formed Nimiq user-friendly address with a valid IBAN-style (mod 97) checksum. */
export function isNimAddress(addr: string): boolean {
  const a = canonicalNimAddress(addr);
  if (!/^NQ\d{2}[0-9A-Z]{32}$/.test(a)) return false;
  if ([...a.slice(4)].some((c) => !ALPHABET.includes(c))) return false;
  // IBAN rule: move the first four characters to the end, letters → numbers (A=10 … Z=35), mod 97 = 1.
  const digits = [...(a.slice(4) + a.slice(0, 4))].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

export function treasuryAddress(): string | null {
  const t = process.env.NIMIQ_TREASURY_ADDRESS;
  return t && isNimAddress(t) ? canonicalNimAddress(t) : null;
}

// ── Payment reference ─────────────────────────────────────────────────────────────────────────

/**
 * Most bytes of recipient data a basic Nimiq transaction may carry (Albatross
 * Policy::MAX_BASIC_TX_RECIPIENT_DATA_SIZE). A longer memo makes the payment invalid: Nimiq Pay's
 * cosigner can't get it accepted and the send sits "Pending" → "outcome unknown".
 */
export const MAX_NIM_MEMO_BYTES = 64;

/**
 * The text a payment carries in its recipient data: ties it to exactly one intent. The app sends
 * it as PLAIN TEXT (Nimiq Pay stores `data` as UTF-8), so its byte length is what goes on chain —
 * "abapay:nim_<uuid>" is 47 bytes. Throws rather than issue a reference no payment could carry.
 */
export function paymentReference(intentId: string): string {
  const ref = `abapay:${intentId.replace(/^preflight_/, '')}`;
  if (Buffer.byteLength(ref, 'utf8') > MAX_NIM_MEMO_BYTES) {
    throw new Error(`NIM payment reference is ${Buffer.byteLength(ref, 'utf8')} bytes; a Nimiq payment carries at most ${MAX_NIM_MEMO_BYTES}.`);
  }
  return ref;
}

function hexToUtf8(hex: string): string {
  try {
    return Buffer.from(hex || '', 'hex').toString('utf8');
  } catch {
    return '';
  }
}

// ── Price ─────────────────────────────────────────────────────────────────────────────────────

let priceCache: { usd: number; at: number } | null = null;
const PRICE_TTL_MS = 60_000;

// Exchanges whose NIM market counts: dollar-stablecoin quotes, fresh, not flagged, with real volume.
const MIN_MARKET_VOLUME_USD = 500;
const STALE_PRICE_MAX_MS = 3 * PRICE_TTL_MS;

type CoinGeckoTicker = {
  target?: string; is_stale?: boolean; is_anomaly?: boolean; trust_score?: string | null;
  bid_ask_spread_percentage?: number | null;
  converted_last?: { usd?: number }; converted_volume?: { usd?: number };
};

/**
 * The price NIM can actually be SOLD at, per exchange: the last trade less half the bid/ask
 * spread (≈ the best bid), for each market that qualifies. Exported for tests.
 */
export function exchangeBidsUsd(tickers: CoinGeckoTicker[]): number[] {
  return tickers
    .filter((t) => ['USDT', 'USD', 'USDC'].includes(String(t.target || '').toUpperCase()))
    .filter((t) => !t.is_stale && !t.is_anomaly && t.trust_score !== 'red')
    .filter((t) => Number(t.converted_volume?.usd) >= MIN_MARKET_VOLUME_USD)
    .map((t) => {
      const last = Number(t.converted_last?.usd);
      const spread = Math.min(Math.max(Number(t.bid_ask_spread_percentage) || 0, 0), 20) / 100;
      return last * (1 - spread / 2);
    })
    .filter((p) => Number.isFinite(p) && p > 0);
}

/**
 * NIM's US-dollar price for quoting, cached for a minute. Null when it can't be read: the caller
 * must then refuse to price an intent rather than guess.
 *
 * 🔴 PRICED AT WHAT NIM SELLS FOR, NOT AT AN AVERAGE. CoinGecko's simple price is a volume-weighted
 * blend of last trades; the NIM a customer pays is later sold on an exchange at its bid. So the
 * quote uses the LOWEST bid across the qualifying exchange markets (Gate, KuCoin… — the ones an
 * operator actually converts on), and never more than the blended price. The blended price alone
 * is the fallback when no market qualifies. A lower NIM price means more NIM per naira: the
 * conservative side for us, and NIMIQ_PRICE_BUFFER still sits on top.
 */
export async function nimUsdPrice(): Promise<number | null> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.usd;
  const get = (url: string) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [simple, tickers] = await Promise.all([
    get('https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd'),
    get('https://api.coingecko.com/api/v3/coins/nimiq-2/tickers?order=volume_desc'),
  ]);
  const blended = Number(simple?.['nimiq-2']?.usd);
  const bids = exchangeBidsUsd(Array.isArray(tickers?.tickers) ? tickers.tickers : []);
  const candidates = [...bids, ...(Number.isFinite(blended) && blended > 0 ? [blended] : [])];
  if (!candidates.length) {
    // A stale price up to three minutes old is still usable; older than that, refuse.
    return priceCache && Date.now() - priceCache.at < STALE_PRICE_MAX_MS ? priceCache.usd : null;
  }
  const usd = Math.min(...candidates);
  priceCache = { usd, at: Date.now() };
  return usd;
}

/** A buffer on top of the spot price, covering the drift between quoting and converting NIM. */
export const PRICE_BUFFER = Number(process.env.NIMIQ_PRICE_BUFFER || 0.02);

/** Luna owed for a US-dollar amount at `nimUsd`, buffer included, rounded up to the next whole NIM. */
export function lunaForUsd(usd: number, nimUsd: number): number {
  const nim = (usd / nimUsd) * (1 + PRICE_BUFFER);
  return Math.ceil(nim) * LUNA_PER_NIM;
}

// ── Chain reads ───────────────────────────────────────────────────────────────────────────────

export type NimTransaction = {
  hash: string;
  blockNumber: number;
  timestamp: number;
  confirmations: number;
  from: string;
  to: string;
  /** Account types: 0 basic, 1 vesting, 2 HTLC, 3 staking. */
  fromType?: number;
  toType?: number;
  value: number;
  fee: number;
  recipientData: string;
  networkId: number;
  executionResult: boolean;
};

type RpcResult<T> = { ok: true; value: T | null } | { ok: false; detail: string };

async function rpc<T>(method: string, params: unknown[]): Promise<RpcResult<T>> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `RPC HTTP ${res.status}` };
    const body = await res.json();
    // Albatross answers an unknown hash with an error object, not a null result.
    if (body?.error) return { ok: true, value: null };
    return { ok: true, value: (body?.result?.data ?? null) as T | null };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export const NIM_TX_HASH_RE = /^[0-9a-f]{64}$/;

type HtlcAccount = { type?: string; balance?: number; sender?: string; recipient?: string; timeout?: number };

/**
 * Who funded an HTLC: the contract's own `sender` while it exists, else the sender of the
 * transaction that created it (an emptied HTLC is gone from state but not from history).
 * `undefined` = the chain couldn't be read (undecided); null = not an HTLC / no funder found.
 */
export async function htlcFunder(htlcAddress: string): Promise<string | null | undefined> {
  const acct = await rpc<HtlcAccount>('getAccountByAddress', [formatNimAddress(htlcAddress)]);
  if (!acct.ok) return undefined;
  if (acct.value?.type === 'htlc' && acct.value.sender) return canonicalNimAddress(acct.value.sender);
  const hist = await rpc<NimTransaction[]>('getTransactionsByAddress', [formatNimAddress(htlcAddress), 50, null]);
  if (!hist.ok) return undefined;
  const target = canonicalNimAddress(htlcAddress);
  const creation = (hist.value || []).find((t) => canonicalNimAddress(t.to) === target && t.toType === 2);
  return creation ? canonicalNimAddress(creation.from) : null;
}

/**
 * 🔴 NIMIQ PAY HOLDS A USER'S NIM IN HTLCs THEIR OWN ADDRESS FUNDED, not in the plain account
 * (2026-10-17: a wallet Nimiq Pay showed at 6,789 NIM had a basic balance of 0 and the 6,789 NIM
 * in an HTLC whose sender was that address, timing out in ~2 weeks). So a wallet's NIM is its
 * basic balance PLUS every unexpired HTLC it is the sender of — found from its outgoing
 * transactions into HTLCs (toType 2), each confirmed by reading the HTLC itself.
 *
 * Read from the Nimiq chain — the source of truth at Pay. Null when the chain can't be read:
 * the caller then must not refuse on balance (Nimiq Pay refuses an unaffordable send itself).
 */
export async function nimBalanceLuna(address: string, now = Date.now()): Promise<number | null> {
  if (!isNimAddress(address)) return null;
  const me = canonicalNimAddress(address);
  const read = await rpc<{ balance?: number }>('getAccountByAddress', [formatNimAddress(address)]);
  if (!read.ok || !read.value) return null;
  const basic = Number(read.value.balance);
  if (!Number.isFinite(basic) || basic < 0) return null;

  const hist = await rpc<NimTransaction[]>('getTransactionsByAddress', [formatNimAddress(address), 100, null]);
  // Unknown, not the plain balance: for a Nimiq Pay wallet that is 0 and would refuse a funded one.
  if (!hist.ok) return null;
  // 🔴 NIMIQ PAY ROLLS THE HTLC OVER. Before the old one times out it moves the remainder
  // HTLC → new HTLC (2026-10-24: 6,006.055 NIM from NQ41 339U… into NQ34 V8N1…, sender still the
  // wallet), so the new contract is NOT funded from the wallet's own address and a scan of the
  // wallet's outgoing transactions alone read 0. So walk the chain: every HTLC the wallet funded,
  // and every HTLC one of those moved funds into, counted when its `sender` is this wallet.
  const queue = [...new Set((hist.value || [])
    .filter((t) => t.toType === 2 && canonicalNimAddress(t.from) === me)
    .map((t) => canonicalNimAddress(t.to)))];
  const seen = new Set<string>();
  let locked = 0;
  while (queue.length && seen.size < 20) {
    const h = queue.shift()!;
    if (seen.has(h)) continue;
    seen.add(h);
    const a = await rpc<HtlcAccount>('getAccountByAddress', [formatNimAddress(h)]);
    if (!a.ok) return null; // part of the wallet unreadable: unknown, never a short figure
    const live = a.value?.type === 'htlc' && !!a.value.sender && canonicalNimAddress(a.value.sender) === me
      && !(Number(a.value.timeout) && Number(a.value.timeout) <= now); // expired: refundable, not spendable via Pay
    if (live) {
      const b = Number(a.value!.balance);
      if (Number.isFinite(b) && b > 0) locked += b;
    }
    // Follow where this HTLC sent funds into another HTLC (a rollover) — whether or not it is
    // still live, since an emptied one is exactly the one that rolled over.
    if (live || a.value?.type !== 'htlc') {
      const out = await rpc<NimTransaction[]>('getTransactionsByAddress', [formatNimAddress(h), 50, null]);
      if (!out.ok) return null;
      for (const t of out.value || []) {
        if (t.toType === 2 && canonicalNimAddress(t.from) === h) queue.push(canonicalNimAddress(t.to));
      }
    }
  }
  return basic + locked;
}

export async function getNimTransaction(hash: string): Promise<RpcResult<NimTransaction>> {
  return rpc<NimTransaction>('getTransactionByHash', [hash.toLowerCase()]);
}

/**
 * The treasury's newest transactions, keyed by the order reference they carry. Lets the sweep find
 * a payment whose settle call never arrived (the app closed after the wallet sent it).
 */
export async function recentTreasuryPayments(max = 500): Promise<Map<string, NimTransaction> | null> {
  const treasury = treasuryAddress();
  if (!treasury) return null;
  const read = await rpc<NimTransaction[]>('getTransactionsByAddress', [formatNimAddress(treasury), max, null]);
  if (!read.ok || !read.value) return null;
  const byRef = new Map<string, NimTransaction>();
  for (const tx of read.value) {
    if (canonicalNimAddress(tx.to) !== treasury) continue;
    const ref = hexToUtf8(tx.recipientData).trim();
    if (ref.startsWith('abapay:') && !byRef.has(ref)) byRef.set(ref, tx);
  }
  return byRef;
}

// ── Payment proof ─────────────────────────────────────────────────────────────────────────────

export type NimProofFailure =
  | 'TREASURY_NOT_CONFIGURED'
  | 'RPC_UNAVAILABLE'   // couldn't ask the chain: undecided, not a verdict
  | 'NOT_FOUND'         // not on chain yet (or never): undecided
  | 'UNCONFIRMED'       // on chain, not deep enough yet: undecided
  | 'WRONG_NETWORK'
  | 'FAILED'            // executionResult false: no funds moved
  | 'WRONG_RECIPIENT'
  | 'REFERENCE_MISMATCH'
  | 'AMOUNT_SHORT'
  | 'SENDER_MISMATCH';

/** Failures that say nothing about the payment: leave the intent PENDING and try again later. */
export const UNDECIDED_NIM_FAILURES: ReadonlySet<NimProofFailure> = new Set(['RPC_UNAVAILABLE', 'NOT_FOUND', 'UNCONFIRMED']);

export type NimProof =
  | { ok: true; tx: NimTransaction }
  | { ok: false; code: NimProofFailure; detail: string };

/** Did the treasury receive at least `minLuna` from this transaction, tagged for `intentId`? */
export async function verifyNimPayment(hash: string, expected: { minLuna: number; intentId: string; payer?: string | null }): Promise<NimProof> {
  const treasury = treasuryAddress();
  if (!treasury) return { ok: false, code: 'TREASURY_NOT_CONFIGURED', detail: 'NIMIQ_TREASURY_ADDRESS is not set to a valid address.' };

  const read = await getNimTransaction(hash);
  if (!read.ok) {
    metric('nim_rpc_errors_total', 1);
    return { ok: false, code: 'RPC_UNAVAILABLE', detail: read.detail };
  }
  const tx = read.value;
  if (!tx) return { ok: false, code: 'NOT_FOUND', detail: `Transaction ${hash} is not on chain yet.` };

  if (tx.networkId !== MAINNET_NETWORK_ID && process.env.NIMIQ_ALLOW_TESTNET !== 'true') {
    return { ok: false, code: 'WRONG_NETWORK', detail: `Transaction is on network ${tx.networkId}, not mainnet.` };
  }
  if (tx.executionResult === false) return { ok: false, code: 'FAILED', detail: 'The transaction failed on chain; no NIM moved.' };
  if (canonicalNimAddress(tx.to) !== treasury) {
    return { ok: false, code: 'WRONG_RECIPIENT', detail: `Paid ${formatNimAddress(tx.to)}, not the AbaPay treasury.` };
  }
  if (hexToUtf8(tx.recipientData).trim() !== paymentReference(expected.intentId)) {
    return { ok: false, code: 'REFERENCE_MISMATCH', detail: 'The payment does not carry this order’s reference.' };
  }
  if (!(Number(tx.value) >= expected.minLuna)) {
    return { ok: false, code: 'AMOUNT_SHORT', detail: `Received ${Number(tx.value) / LUNA_PER_NIM} NIM, order requires ${expected.minLuna / LUNA_PER_NIM} NIM.` };
  }
  if (expected.payer && isNimAddress(expected.payer) && canonicalNimAddress(tx.from) !== canonicalNimAddress(expected.payer)) {
    // Nimiq Pay pays out of the HTLC the user's own address funded (see nimBalanceLuna), so the
    // transfer can come FROM that HTLC. It's still the ordering wallet's NIM when the chain shows
    // that wallet funded the HTLC; anything else is a different payer. An unreadable chain is
    // undecided (retried), never a mismatch.
    const funder = tx.fromType === 2 || tx.fromType === undefined ? await htlcFunder(tx.from) : null;
    if (funder === undefined) {
      metric('nim_rpc_errors_total', 1);
      return { ok: false, code: 'RPC_UNAVAILABLE', detail: 'Could not read who funded the sending HTLC.' };
    }
    if (funder !== canonicalNimAddress(expected.payer)) {
      return { ok: false, code: 'SENDER_MISMATCH', detail: `Sent from ${formatNimAddress(tx.from)}, not the wallet that placed the order.` };
    }
  }
  if (Number(tx.confirmations) < MIN_CONFIRMATIONS) {
    return { ok: false, code: 'UNCONFIRMED', detail: `${tx.confirmations} of ${MIN_CONFIRMATIONS} confirmations.` };
  }
  return { ok: true, tx };
}

/** Did the operator's refund really send at least `minLuna` from the treasury to `to`? */
export async function verifyNimRefund(hash: string, expected: { to: string; minLuna: number }): Promise<{ status: 'CONFIRMED' | 'PENDING' | 'FAILED' | 'MISMATCH'; detail: string }> {
  const read = await getNimTransaction(hash);
  if (!read.ok) return { status: 'PENDING', detail: read.detail };
  const tx = read.value;
  if (!tx) return { status: 'PENDING', detail: 'Not on chain yet.' };
  if (tx.executionResult === false) return { status: 'FAILED', detail: 'The refund transaction failed on chain.' };
  const treasury = treasuryAddress();
  if (treasury && canonicalNimAddress(tx.from) !== treasury) return { status: 'MISMATCH', detail: `Sent from ${formatNimAddress(tx.from)}, not the treasury.` };
  if (canonicalNimAddress(tx.to) !== canonicalNimAddress(expected.to)) return { status: 'MISMATCH', detail: `Sent to ${formatNimAddress(tx.to)}, not the payer.` };
  if (!(Number(tx.value) >= expected.minLuna)) return { status: 'MISMATCH', detail: `Sent ${Number(tx.value) / LUNA_PER_NIM} NIM, ${expected.minLuna / LUNA_PER_NIM} NIM owed.` };
  if (Number(tx.confirmations) < MIN_CONFIRMATIONS) return { status: 'PENDING', detail: 'Waiting for confirmations.' };
  return { status: 'CONFIRMED', detail: 'Refund confirmed on chain.' };
}
