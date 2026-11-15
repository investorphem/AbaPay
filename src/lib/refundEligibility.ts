// Whether an order can owe the customer a refund at all: only when its payment provably landed on
// chain. Pure — shared by the admin ledger (which buttons to show) and its refund guard.
//
// 2026-11-15: the ledger offered "Refund" on every PENDING/PROCESSING and FAILED_* row, including
// orders whose payment never arrived. Refunding one pays out money that was never received.
//
// Two separate rails, judged separately — never mixed:
//   • NIM (blockchain 'NIMIQ', nim.abapays.com): paid in NIM on the Nimiq chain. The order's id is a
//     `preflight_nim_…` placeholder until a payment is seen, then the 64-hex Nimiq transaction hash.
//   • Celo / Base (EVM): paid in stablecoins, by payBill, the agent relayer or x402. x402 is a
//     Celo/Base rail only; its codes and its settle hash never apply to a NIM order.

/** Statuses an unfinished or failed order can be in when a refund may be owed. */
const REFUNDABLE_STATUS = (status: string) => status === 'PENDING' || status === 'PROCESSING' || status.startsWith('FAILED');

const NIM_HASH = /^[0-9a-f]{64}$/i;
const EVM_HASH = /^0x[0-9a-f]{64}$/i;

/** Celo/Base error codes that mean no money reached the vault. */
const EVM_NOTHING_RECEIVED = new Set(['REVERTED', 'AGENT_PREFLIGHT_FAILED', 'X402_SETTLE_REFUSED', 'X402_AUTH_CANCELLED']);

export interface RefundableTx {
  status?: string | null;
  error_code?: string | null;
  tx_hash?: string | null;
  x402_settle_tx?: string | null;
  blockchain?: string | null;
  refund_hash?: string | null;
}

/** NIM: paid only once the order carries a real Nimiq transaction hash. */
function nimPaid(tx: RefundableTx): boolean {
  if (tx.status === 'FAILED_PAYMENT') return false;
  return NIM_HASH.test(String(tx.tx_hash || ''));
}

/** Celo / Base: a real EVM transaction hash, or an x402 payment that settled. */
function evmPaid(tx: RefundableTx): boolean {
  // A refused x402 authorization that was spent afterwards: the money moved, though the row keeps
  // its placeholder hash (src/lib/reconcileX402.ts).
  if (tx.error_code === 'X402_LATE_SETTLEMENT') return true;
  if (tx.error_code && EVM_NOTHING_RECEIVED.has(tx.error_code)) return false;
  if (tx.status === 'FAILED_PAYMENT') return false;
  return EVM_HASH.test(String(tx.tx_hash || '')) || EVM_HASH.test(String(tx.x402_settle_tx || ''));
}

/** True when the payment landed on chain, so a refund can be owed. */
export function paymentLandedOnChain(tx: RefundableTx): boolean {
  return String(tx.blockchain || '').toUpperCase() === 'NIMIQ' ? nimPaid(tx) : evmPaid(tx);
}

/** Whether the ledger should offer Refund for this row. */
export function canOfferRefund(tx: RefundableTx): boolean {
  if (tx.refund_hash) return false; // already refunded on chain
  return REFUNDABLE_STATUS(String(tx.status || '')) && paymentLandedOnChain(tx);
}
