import { describe, it, expect, vi, beforeEach } from 'vitest';

// Before a Celo/Base refund leaves the vault, the order's ORIGINAL payment must be proven on chain
// (src/lib/orderPaymentProof.ts). 2026-11-16: a prober recorded a made-up 0xdede… hash on a Base
// order, which the ledger then offered to refund.

vi.mock('server-only', () => ({}));
const vault = vi.fn();
const transfer = vi.fn();
vi.mock('@/lib/paymentProof', () => ({
  verifyVaultPayment: (...a: unknown[]) => vault(...a),
  verifyTokenTransfer: (...a: unknown[]) => transfer(...a),
  vaultAddressFor: () => '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c',
  UNDECIDED_PROOF_FAILURES: new Set(['NOT_FOUND', 'RPC_UNAVAILABLE']),
}));
vi.mock('@/lib/chain', () => ({ isMainnetEnv: () => true }));
vi.mock('@/constants', () => ({ resolveTokenOnChain: () => ({ decimals: 6 }), normalizeChainName: (c: string) => c }));

const { proveOrderPaid } = await import('@/lib/orderPaymentProof');

const HASH = '0x' + 'de'.repeat(32);
const row = (over: Record<string, unknown> = {}) => ({
  blockchain: 'BASE', status: 'PENDING', error_code: null, payment_method: null, tx_hash: HASH, x402_settle_tx: null,
  x402_payer: null, wallet_address: '0x633dba1a394239a0bfb343b902f98e172c9b3cf2', token_used: 'USDC', amount_usdt: 0.08,
  account_number: '08012345678', service_id: 'mtn', ...over,
});

beforeEach(() => { vault.mockReset(); transfer.mockReset(); });

describe('proveOrderPaid — Celo/Base', () => {
  it('refuses a made-up hash the vault never saw (the 0xdede… order)', async () => {
    vault.mockResolvedValue({ ok: false, code: 'NO_EVENT', detail: 'no PaymentReceived' });
    expect((await proveOrderPaid(row())).status).toBe('NOT_PAID');
  });

  it('confirms a payment the vault recorded', async () => {
    vault.mockResolvedValue({ ok: true });
    expect((await proveOrderPaid(row())).status).toBe('PAID');
    expect(vault).toHaveBeenCalledWith(HASH, expect.objectContaining({ blockchain: 'BASE', tokenSymbol: 'USDC', accountNumber: '08012345678' }));
  });

  it('says UNDECIDED (never PAID) when the chain cannot be asked or the tx is not found yet', async () => {
    vault.mockResolvedValue({ ok: false, code: 'RPC_UNAVAILABLE', detail: 'down' });
    expect((await proveOrderPaid(row())).status).toBe('UNDECIDED');
    vault.mockResolvedValue({ ok: false, code: 'NOT_FOUND', detail: 'no receipt' });
    expect((await proveOrderPaid(row())).status).toBe('UNDECIDED');
  });

  it('proves an x402 order by its settlement transfer into the vault', async () => {
    transfer.mockResolvedValue({ ok: true });
    const r = await proveOrderPaid(row({ payment_method: 'X402', tx_hash: 'preflight_x402_BASE_0x633', x402_settle_tx: HASH, x402_payer: '0x633dba1a394239a0bfb343b902f98e172c9b3cf2' }));
    expect(r.status).toBe('PAID');
    expect(transfer).toHaveBeenCalledWith(HASH, expect.objectContaining({ to: '0x5df8ae2b963165b735b18ca86b1ea448d2aa032c', minAmountWei: 80000n }));
  });

  it('refuses an order with no payment transaction, and sends a late x402 settlement to a manual check', async () => {
    expect((await proveOrderPaid(row({ tx_hash: 'preflight_0x633_1' }))).status).toBe('NOT_PAID');
    expect((await proveOrderPaid(row({ payment_method: 'X402', error_code: 'X402_LATE_SETTLEMENT', tx_hash: 'preflight_x402_CELO_0x1' }))).status).toBe('CHECK_MANUALLY');
    expect(vault).not.toHaveBeenCalled();
  });

  it('never judges a NIM order — those go through Ops → Refunds and the Nimiq chain', async () => {
    expect((await proveOrderPaid(row({ blockchain: 'NIMIQ', tx_hash: 'cd'.repeat(32) }))).status).toBe('NOT_PAID');
    expect(vault).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
});
