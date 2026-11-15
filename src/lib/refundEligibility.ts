// Whether an order can owe the customer a refund at all: only when its payment provably landed on
// chain. Pure — shared by the admin ledger (which buttons to show) and its refund guard.
//
// 2026-11-15: the ledger offered "Refund" on every PENDING/PROCESSING and FAILED_* row, including
// orders whose payment never arrived — a `preflight_…` placeholder hash (never broadcast; NIM
// intents use `preflight_nim_`), a FAILED_PAYMENT, an x402 authorization the facilitator refused or
// that was cancelled. Refunding any of those pays out vault/treasury money that was never received.

/** Error codes that mean no money reached the vault. */
const NOTHING_RECEIVED = new Set(['REVERTED', 'AGENT_PREFLIGHT_FAILED', 'X402_SETTLE_REFUSED', 'X402_AUTH_CANCELLED']);

/** Statuses an unfinished or failed order can be in when a refund may be owed. */
const REFUNDABLE_STATUS = (status: string) => status === 'PENDING' || status === 'PROCESSING' || status.startsWith('FAILED');

const isRealHash = (hash: unknown, blockchain: unknown) => {
  const h = String(hash || '');
  if (/^0x[0-9a-f]{64}$/i.test(h)) return true; // Celo / Base
  return String(blockchain || '').toUpperCase() === 'NIMIQ' && /^[0-9a-f]{64}$/i.test(h); // Nimiq
};

export interface RefundableTx {
  status?: string | null;
  error_code?: string | null;
  tx_hash?: string | null;
  x402_settle_tx?: string | null;
  blockchain?: string | null;
  refund_hash?: string | null;
}

/** True when the payment landed on chain, so a refund can be owed. */
export function paymentLandedOnChain(tx: RefundableTx): boolean {
  // A refused x402 authorization that was spent afterwards: the money moved, though the row keeps
  // its placeholder hash (src/lib/reconcileX402.ts).
  if (tx.error_code === 'X402_LATE_SETTLEMENT') return true;
  if (tx.error_code && NOTHING_RECEIVED.has(tx.error_code)) return false;
  if (tx.status === 'FAILED_PAYMENT') return false;
  return isRealHash(tx.tx_hash, tx.blockchain) || isRealHash(tx.x402_settle_tx, tx.blockchain);
}

/** Whether the ledger should offer Refund for this row. */
export function canOfferRefund(tx: RefundableTx): boolean {
  if (tx.refund_hash) return false; // already refunded on chain
  return REFUNDABLE_STATUS(String(tx.status || '')) && paymentLandedOnChain(tx);
}
