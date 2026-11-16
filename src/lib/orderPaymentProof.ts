import 'server-only';
import { parseUnits } from 'viem';
import { resolveTokenOnChain, normalizeChainName } from '@/constants';
import { isMainnetEnv } from '@/lib/chain';
import { verifyTokenTransfer, verifyVaultPayment, vaultAddressFor, UNDECIDED_PROOF_FAILURES } from '@/lib/paymentProof';

// 🔐 BEFORE A CELO/BASE REFUND LEAVES THE VAULT: prove the order's ORIGINAL payment on chain.
//
// 2026-11-16: a prober told /api/pay it had paid with a made-up hash (0xdede…, Base). The order sat
// PENDING with that hash, and the ledger offered Refund because the hash *looked* real — clicking it
// would have paid vault money out for a payment that never happened. A hash's format proves
// nothing; only the chain does.
//
// Celo / Base only. NIM orders never carry an unverified hash: the server proves the payment on the
// Nimiq chain before an order gets its hash (src/lib/nimSettle.ts), and the NIM refund queue checks
// that again.

export type OrderPaymentVerdict =
  | { status: 'PAID'; detail: string }
  | { status: 'NOT_PAID'; detail: string }
  /** The chain couldn't be asked, or the transaction isn't mined yet: try again later, never pay. */
  | { status: 'UNDECIDED'; detail: string }
  /** The money moved but the order has no hash to prove it with (an x402 late settlement). */
  | { status: 'CHECK_MANUALLY'; detail: string };

export interface OrderRow {
  blockchain: string | null;
  status: string | null;
  error_code: string | null;
  payment_method: string | null;
  tx_hash: string | null;
  x402_settle_tx: string | null;
  x402_payer: string | null;
  wallet_address: string | null;
  token_used: string | null;
  amount_usdt: number | string | null;
  account_number: string | null;
  service_id: string | null;
}

const EVM_HASH = /^0x[0-9a-f]{64}$/i;

export async function proveOrderPaid(row: OrderRow): Promise<OrderPaymentVerdict> {
  if (String(row.blockchain || '').toUpperCase() === 'NIMIQ') {
    return { status: 'NOT_PAID', detail: 'NIM orders are refunded through Ops → Refunds, which checks the Nimiq chain.' };
  }
  if (row.error_code === 'X402_LATE_SETTLEMENT') {
    return { status: 'CHECK_MANUALLY', detail: 'x402 late settlement: the authorization was spent but the order has no transaction hash. Find the payment on the explorer before refunding.' };
  }

  const isX402 = String(row.payment_method || '').toUpperCase() === 'X402';
  const hash = String((isX402 ? row.x402_settle_tx || row.tx_hash : row.tx_hash) || '').toLowerCase();
  if (!EVM_HASH.test(hash)) return { status: 'NOT_PAID', detail: 'This order has no on-chain payment transaction.' };

  if (isX402) {
    const token = resolveTokenOnChain(row.token_used || 'USDC', normalizeChainName(row.blockchain), isMainnetEnv());
    const vault = vaultAddressFor(row.blockchain);
    const payer = row.x402_payer || row.wallet_address;
    if (!token || !vault || !payer) return { status: 'UNDECIDED', detail: 'Token, vault or payer could not be resolved for this order.' };
    const proof = await verifyTokenTransfer(hash, {
      blockchain: row.blockchain, tokenSymbol: row.token_used || 'USDC', from: payer, to: vault,
      minAmountWei: parseUnits(Number(row.amount_usdt || 0).toFixed(token.decimals), token.decimals),
    });
    if (proof.ok) return { status: 'PAID', detail: 'The x402 settlement moved the tokens into the vault.' };
    return UNDECIDED_PROOF_FAILURES.has(proof.code)
      ? { status: 'UNDECIDED', detail: `${proof.code}: ${proof.detail}` }
      : { status: 'NOT_PAID', detail: `${proof.code}: ${proof.detail}` };
  }

  const proof = await verifyVaultPayment(hash, {
    blockchain: row.blockchain, tokenSymbol: row.token_used || 'USDC', minAmountCrypto: row.amount_usdt || 0,
    accountNumber: row.account_number || '', serviceId: row.service_id, walletAddress: row.wallet_address,
  });
  if (proof.ok) return { status: 'PAID', detail: 'The vault recorded this payment (PaymentReceived).' };
  return UNDECIDED_PROOF_FAILURES.has(proof.code)
    ? { status: 'UNDECIDED', detail: `${proof.code}: ${proof.detail}` }
    : { status: 'NOT_PAID', detail: `${proof.code}: ${proof.detail}` };
}
