import 'server-only';
import { decodeEventLog, parseUnits, type PublicClient } from 'viem';
import { ABAPAY_CONTRACT_ABI_EVENTS, LEGACY_RECORD_CHAIN, normalizeChainName, resolveTokenOnChain } from '@/constants';
import { getPublicClient, isMainnetEnv } from '@/lib/chain';
import { metric } from '@/lib/log';

// ⚡ ONE ON-CHAIN PAYMENT VERIFIER — "did THIS vault receive THIS payment?"
//
// 🔴 WHY IT EXISTS (ABAPAY_FULL_AUDIT.md P-2 / B-2). /api/pay used to verify a payment by
// decoding the payBill CALLDATA: it compared serviceType, accountNumber and amount — and never
// the token argument — then took the token's decimals from the symbol the CLIENT claimed. USDm
// (18 decimals) is a supported vault token, so paying 10_000_000 wei of USDm (1e-11 USDm) while
// claiming "USDC" matched parseUnits("10", 6) exactly and bought ~$10 of airtime for nothing.
//
// The authority here is the vault's own PaymentReceived EVENT, not calldata:
//   • it is emitted only by the vault, only after `_pull()` actually received the tokens, and
//     with the amount the vault RECEIVED — so a fee-on-transfer or a fake token cannot inflate it;
//   • it is emitted the same way whether the payer's EOA called payBill directly, a smart
//     wallet routed it through an ERC-4337 EntryPoint, or the relayer called payBillFor — so one
//     check covers every rail and there is no EntryPoint allowlist to keep up to date;
//   • token, amount, account, service and payer are all read from it, and decimals come from the
//     token the event names — never from anything the caller sent.
//
// The EXPECTED values must come from the server's own record of the payment (the intent row),
// never from the request being verified: that is the other half of what made the old check
// bypassable.

export type PaymentProofFailure =
  | 'VAULT_NOT_CONFIGURED' // no vault address for this chain — refuse, never guess
  | 'TOKEN_UNKNOWN'        // the expected symbol does not resolve on this chain
  | 'NOT_FOUND'            // no receipt yet (still pending, or not on this chain)
  | 'RPC_UNAVAILABLE'      // could not ask the chain at all — undecided, NOT a failure verdict
  | 'REVERTED'
  | 'NO_EVENT'             // succeeded, but this vault emitted no PaymentReceived
  | 'TOKEN_MISMATCH'
  | 'AMOUNT_SHORT'
  | 'ACCOUNT_MISMATCH'
  | 'SERVICE_MISMATCH'
  | 'SENDER_MISMATCH';

/** Failures that say nothing about the payment itself — the caller should retry later. */
export const UNDECIDED_PROOF_FAILURES: ReadonlySet<PaymentProofFailure> = new Set(['NOT_FOUND', 'RPC_UNAVAILABLE']);

export interface ExpectedVaultPayment {
  /** The chain the record says it was paid on ('BASE' | 'CELO', or a stored legacy value). */
  blockchain: string | null | undefined;
  tokenSymbol: string;
  /** The crypto amount the record requires, in whole tokens. */
  minAmountCrypto: number | string;
  accountNumber: string;
  /** VTpass serviceID — compared with the event's serviceType when provided. */
  serviceId?: string | null;
  /** Required payer. Skipped when absent or the legacy 'unknown' placeholder. */
  walletAddress?: string | null;
}

export type VaultPaymentProof =
  | { ok: true; vault: string; logIndex: number; payer: string; token: string; amountWei: bigint; decimals: number; blockNumber: bigint }
  | { ok: false; code: PaymentProofFailure; detail: string };

/** `PaymentReceived(address indexed user, address indexed token, string serviceType, string accountNumber, uint256 amount)` */
interface PaymentReceivedArgs {
  user: string;
  token: string;
  serviceType: string;
  accountNumber: string;
  amount: bigint;
}

// Float rounding on the client can land a hair under the recorded amount. One cent, in the
// token's own units — the same grace /api/webhook and the refund verifier already allow.
const AMOUNT_TOLERANCE = '0.01';

export function vaultAddressFor(blockchain: string | null | undefined): string | null {
  const chain = normalizeChainName(blockchain || LEGACY_RECORD_CHAIN);
  const address = chain === 'BASE' ? process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS : process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS;
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

const ERC20_TRANSFER_EVENT = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;

export type TokenTransferProof =
  | { ok: true; logIndex: number; amountWei: bigint; blockNumber: bigint }
  | { ok: false; code: PaymentProofFailure; detail: string };

/**
 * Verify that `txHash` moved at least `minAmountWei` of `tokenSymbol` from `from` to `to`.
 *
 * For the x402 rail: a facilitator settles with the token's own `transferWithAuthorization`, so
 * the vault emits nothing — the proof is the TOKEN's Transfer log. Used to stop trusting the
 * facilitator's `{ success, transaction }` reply on its own word (ABAPAY_FULL_AUDIT.md P-7).
 * Only a log emitted BY the expected token contract counts; any other contract can emit a
 * Transfer-shaped event.
 */
// Every check is counted (M5): payments_verified_total{check, chain, result}. A rising share of
// NOT_FOUND / RPC_UNAVAILABLE is the early sign of an RPC problem; WRONG_* codes of tampering.
export async function verifyTokenTransfer(
  txHash: string,
  expected: { blockchain: string | null | undefined; tokenSymbol: string; from: string; to: string; minAmountWei: bigint },
  opts: { waitMs?: number; client?: PublicClient } = {},
): Promise<TokenTransferProof> {
  const proof = await verifyTokenTransferImpl(txHash, expected, opts);
  metric('payments_verified_total', 1, { check: 'token_transfer', chain: normalizeChainName(expected.blockchain || LEGACY_RECORD_CHAIN), result: proof.ok ? 'ok' : proof.code });
  return proof;
}

async function verifyTokenTransferImpl(
  txHash: string,
  expected: { blockchain: string | null | undefined; tokenSymbol: string; from: string; to: string; minAmountWei: bigint },
  opts: { waitMs?: number; client?: PublicClient } = {},
): Promise<TokenTransferProof> {
  const blockchain = expected.blockchain || LEGACY_RECORD_CHAIN;
  const token = resolveTokenOnChain(expected.tokenSymbol, normalizeChainName(blockchain), isMainnetEnv());
  if (!token) {
    return { ok: false, code: 'TOKEN_UNKNOWN', detail: `${expected.tokenSymbol} is not a known token on ${normalizeChainName(blockchain)}.` };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, code: 'NOT_FOUND', detail: 'Not a transaction hash.' };
  }

  const client = opts.client ?? getPublicClient(blockchain);
  let receipt;
  try {
    receipt = opts.waitMs && opts.waitMs > 0
      ? await client.waitForTransactionReceipt({ hash: txHash as `0x${string}`, confirmations: 1, timeout: opts.waitMs })
      : await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (err) {
    const e = err as { name?: string; shortMessage?: string; message?: string };
    if (e?.name === 'TransactionReceiptNotFoundError' || e?.name === 'WaitForTransactionReceiptTimeoutError') {
      return { ok: false, code: 'NOT_FOUND', detail: 'No receipt for this transaction yet.' };
    }
    return { ok: false, code: 'RPC_UNAVAILABLE', detail: String(e?.shortMessage || e?.message || err).slice(0, 200) };
  }
  if (receipt.status !== 'success') {
    return { ok: false, code: 'REVERTED', detail: 'Transaction reverted on-chain.' };
  }

  const from = norm(expected.from);
  const to = norm(expected.to);
  let short: TokenTransferProof | null = null;
  for (const log of receipt.logs) {
    if (norm(log.address) !== token.address) continue;
    let args: { from: string; to: string; value: bigint };
    try {
      const decoded = decodeEventLog({ abi: ERC20_TRANSFER_EVENT, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') continue;
      args = decoded.args as { from: string; to: string; value: bigint };
    } catch {
      continue;
    }
    if (norm(args.from) !== from || norm(args.to) !== to) continue;
    if (args.value >= expected.minAmountWei) {
      return { ok: true, logIndex: Number(log.logIndex), amountWei: args.value, blockNumber: receipt.blockNumber };
    }
    short ??= { ok: false, code: 'AMOUNT_SHORT', detail: `Transferred ${args.value} base units, expected at least ${expected.minAmountWei}.` };
  }
  return short ?? { ok: false, code: 'NO_EVENT', detail: `No ${expected.tokenSymbol} transfer from ${expected.from} to ${expected.to} in this transaction.` };
}

/**
 * Verify that `txHash` paid the configured vault for `expected`.
 *
 * `waitMs > 0` waits up to that long for the receipt (the synchronous /api/pay path, where the
 * client has only just broadcast). `waitMs = 0` reads it once (webhooks, reconcilers).
 */
export async function verifyVaultPayment(
  txHash: string,
  expected: ExpectedVaultPayment,
  opts: { waitMs?: number; client?: PublicClient } = {},
): Promise<VaultPaymentProof> {
  const proof = await verifyVaultPaymentImpl(txHash, expected, opts);
  metric('payments_verified_total', 1, { check: 'vault_event', chain: normalizeChainName(expected.blockchain || LEGACY_RECORD_CHAIN), result: proof.ok ? 'ok' : proof.code });
  return proof;
}

async function verifyVaultPaymentImpl(
  txHash: string,
  expected: ExpectedVaultPayment,
  opts: { waitMs?: number; client?: PublicClient } = {},
): Promise<VaultPaymentProof> {
  const blockchain = expected.blockchain || LEGACY_RECORD_CHAIN;
  const vault = vaultAddressFor(blockchain);
  if (!vault) {
    return { ok: false, code: 'VAULT_NOT_CONFIGURED', detail: `No AbaPay vault address configured for ${normalizeChainName(blockchain)}.` };
  }

  const token = resolveTokenOnChain(expected.tokenSymbol, normalizeChainName(blockchain), isMainnetEnv());
  if (!token) {
    return { ok: false, code: 'TOKEN_UNKNOWN', detail: `${expected.tokenSymbol} is not a known token on ${normalizeChainName(blockchain)}.` };
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, code: 'NOT_FOUND', detail: 'Not a transaction hash.' };
  }

  const client = opts.client ?? getPublicClient(blockchain);
  let receipt;
  try {
    receipt = opts.waitMs && opts.waitMs > 0
      ? await client.waitForTransactionReceipt({ hash: txHash as `0x${string}`, confirmations: 1, timeout: opts.waitMs })
      : await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (err) {
    const e = err as { name?: string; shortMessage?: string; message?: string };
    if (e?.name === 'TransactionReceiptNotFoundError' || e?.name === 'WaitForTransactionReceiptTimeoutError') {
      return { ok: false, code: 'NOT_FOUND', detail: 'No receipt for this transaction yet.' };
    }
    return { ok: false, code: 'RPC_UNAVAILABLE', detail: String(e?.shortMessage || e?.message || err).slice(0, 200) };
  }

  if (receipt.status !== 'success') {
    return { ok: false, code: 'REVERTED', detail: 'Transaction reverted on-chain.' };
  }

  let requiredWei: bigint;
  try {
    requiredWei = parseUnits(Number(expected.minAmountCrypto).toFixed(token.decimals), token.decimals);
  } catch {
    return { ok: false, code: 'AMOUNT_SHORT', detail: `Unreadable required amount ${expected.minAmountCrypto}.` };
  }
  const tolerance = parseUnits(AMOUNT_TOLERANCE, token.decimals);
  const expectedWallet = norm(expected.walletAddress);
  const checkWallet = /^0x[0-9a-f]{40}$/.test(expectedWallet);

  // Several PaymentReceived logs can share one transaction (a batched smart-wallet call).
  // Accept the first that satisfies EVERY check; if none does, report why the first failed.
  let firstFailure: VaultPaymentProof | null = null;
  for (const log of receipt.logs) {
    if (norm(log.address) !== vault) continue;
    let args: PaymentReceivedArgs;
    try {
      // ABAPAY_CONTRACT_ABI_EVENTS is a plain (non-`as const`) array, so viem can't infer the
      // argument types — they are pinned by the event signature, restated in PaymentReceivedArgs.
      const decoded = decodeEventLog({ abi: ABAPAY_CONTRACT_ABI_EVENTS, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: PaymentReceivedArgs };
      if (decoded.eventName !== 'PaymentReceived') continue;
      args = decoded.args;
    } catch {
      continue; // another event from the vault (AgentPayment, refunds, ...)
    }

    let failure: VaultPaymentProof | null = null;
    const paidWei = BigInt(args.amount);
    if (norm(args.token) !== token.address) {
      failure = { ok: false, code: 'TOKEN_MISMATCH', detail: `Paid ${args.token}, expected ${expected.tokenSymbol} (${token.address}).` };
    } else if (requiredWei > paidWei + tolerance) {
      failure = { ok: false, code: 'AMOUNT_SHORT', detail: `Paid ${paidWei} base units, required ${requiredWei}.` };
    } else if (norm(args.accountNumber) !== norm(expected.accountNumber)) {
      failure = { ok: false, code: 'ACCOUNT_MISMATCH', detail: `Paid for account ${args.accountNumber}, expected ${expected.accountNumber}.` };
    } else if (expected.serviceId && norm(args.serviceType) !== norm(expected.serviceId)) {
      failure = { ok: false, code: 'SERVICE_MISMATCH', detail: `Paid for service ${args.serviceType}, expected ${expected.serviceId}.` };
    } else if (checkWallet && norm(args.user) !== expectedWallet) {
      failure = { ok: false, code: 'SENDER_MISMATCH', detail: `Paid by ${args.user}, expected ${expected.walletAddress}.` };
    }

    if (!failure) {
      return {
        ok: true,
        vault,
        logIndex: Number(log.logIndex),
        payer: norm(args.user),
        token: token.address,
        amountWei: paidWei,
        decimals: token.decimals,
        blockNumber: receipt.blockNumber,
      };
    }
    firstFailure ??= failure;
  }

  return firstFailure ?? { ok: false, code: 'NO_EVENT', detail: 'The AbaPay vault emitted no PaymentReceived in this transaction.' };
}
