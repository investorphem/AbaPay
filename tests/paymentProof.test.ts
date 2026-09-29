import { describe, it, expect, vi, beforeAll } from 'vitest';
import { parseUnits } from 'viem';
import { CELO_VAULT, CELO_TOKENS, OTHER_CONTRACT, PAYER, celoPayment, fakeClient, hash, paymentReceivedLog } from './helpers/chain';

// ⚡ THE SHARED ON-CHAIN VERIFIER (src/lib/paymentProof.ts)
//
// These are the checks that decide whether a real bill gets delivered. The two cases that
// matter most are named ATTACK below: the USDm-for-USDC decimals trick that the old calldata
// check in /api/pay accepted (ABAPAY_FULL_AUDIT.md P-2), and a worthless token pushed at the
// vault with no vault event behind it.

vi.mock('server-only', () => ({}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_NETWORK = 'celo';
  process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = CELO_VAULT;
  process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS = '0xc0a4daa04ded9c54d1239507b5a5e645761ef488';
});

const { verifyVaultPayment, vaultAddressFor } = await import('@/lib/paymentProof');

const expected = {
  blockchain: 'CELO',
  tokenSymbol: 'USDC',
  minAmountCrypto: 1.2,
  accountNumber: '08012345678',
  serviceId: 'mtn',
  walletAddress: PAYER,
};

async function verify(receipt: any, overrides: Partial<typeof expected> = {}) {
  const h = hash(1);
  return verifyVaultPayment(h, { ...expected, ...overrides }, { client: fakeClient({ [h]: receipt }) });
}

describe('verifyVaultPayment', () => {
  it('accepts a genuine payment and reports the matched log', async () => {
    const r = await verify({ status: 'success', logs: [celoPayment('USDC', '1.2', 'mtn', '08012345678', { logIndex: 3 })] });
    expect(r).toMatchObject({ ok: true, vault: CELO_VAULT, logIndex: 3, payer: PAYER, token: CELO_TOKENS.USDC.address, decimals: 6 });
  });

  it('accepts an amount a hair under the record (float rounding) but not a real shortfall', async () => {
    expect((await verify({ status: 'success', logs: [celoPayment('USDC', '1.195', 'mtn', '08012345678')] })).ok).toBe(true);
    const short = await verify({ status: 'success', logs: [celoPayment('USDC', '1.18', 'mtn', '08012345678')] });
    expect(short).toMatchObject({ ok: false, code: 'AMOUNT_SHORT' });
  });

  it('ATTACK: refuses USDm dust recorded as USDC, even when the raw integer matches', async () => {
    // The exact old exploit: 1_200_000 base units — parseUnits("1.2", 6) — but in an 18-decimal
    // token, i.e. 1.2e-12 USDm. The old calldata check compared only the integer.
    const r = await verify({
      status: 'success',
      logs: [paymentReceivedLog({ token: CELO_TOKENS.USDm.address, serviceType: 'mtn', accountNumber: '08012345678', amountWei: parseUnits('1.2', 6) })],
    });
    expect(r).toMatchObject({ ok: false, code: 'TOKEN_MISMATCH' });
  });

  it('ATTACK: refuses a transaction whose only PaymentReceived comes from another contract', async () => {
    const r = await verify({ status: 'success', logs: [celoPayment('USDC', '5', 'mtn', '08012345678', { emitter: OTHER_CONTRACT })] });
    expect(r).toMatchObject({ ok: false, code: 'NO_EVENT' });
  });

  it('refuses a successful transaction with no vault event at all', async () => {
    expect(await verify({ status: 'success', logs: [] })).toMatchObject({ ok: false, code: 'NO_EVENT' });
  });

  it('refuses a reverted transaction', async () => {
    expect(await verify({ status: 'reverted', logs: [] })).toMatchObject({ ok: false, code: 'REVERTED' });
  });

  it('refuses a payment for a different account', async () => {
    const r = await verify({ status: 'success', logs: [celoPayment('USDC', '1.2', 'mtn', '08099999999')] });
    expect(r).toMatchObject({ ok: false, code: 'ACCOUNT_MISMATCH' });
  });

  it('refuses a payment for a different service', async () => {
    const r = await verify({ status: 'success', logs: [celoPayment('USDC', '1.2', 'airtel', '08012345678')] });
    expect(r).toMatchObject({ ok: false, code: 'SERVICE_MISMATCH' });
  });

  it('refuses a payment by a different wallet, but skips the check for the legacy "unknown" placeholder', async () => {
    const other = '0x3333333333333333333333333333333333333333';
    const logs = [celoPayment('USDC', '1.2', 'mtn', '08012345678', { user: other })];
    expect(await verify({ status: 'success', logs })).toMatchObject({ ok: false, code: 'SENDER_MISMATCH' });
    expect((await verify({ status: 'success', logs }, { walletAddress: 'unknown' })).ok).toBe(true);
  });

  it('picks the matching log when a transaction carries several', async () => {
    const r = await verify({
      status: 'success',
      logs: [
        celoPayment('USDC', '0.5', 'mtn', '08012345678', { logIndex: 0 }),
        celoPayment('USDC', '1.2', 'mtn', '08012345678', { logIndex: 1 }),
      ],
    });
    expect(r).toMatchObject({ ok: true, logIndex: 1 });
  });

  it('compares account and service case- and whitespace-insensitively', async () => {
    const r = await verify({ status: 'success', logs: [celoPayment('USDC', '1.2', 'MTN', ' 08012345678 ')] });
    expect(r.ok).toBe(true);
  });

  it('reports a missing receipt as NOT_FOUND and an RPC failure as RPC_UNAVAILABLE — never ok', async () => {
    const h = hash(9);
    expect(await verifyVaultPayment(h, expected, { client: fakeClient({}) })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await verifyVaultPayment(h, expected, { client: fakeClient({ [h]: new Error('socket hang up') }) }))
      .toMatchObject({ ok: false, code: 'RPC_UNAVAILABLE' });
  });

  it('refuses when the vault address is not configured, instead of guessing', async () => {
    const saved = process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS;
    delete process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS;
    try {
      expect(vaultAddressFor('CELO')).toBeNull();
      expect(await verify({ status: 'success', logs: [celoPayment('USDC', '1.2', 'mtn', '08012345678')] }))
        .toMatchObject({ ok: false, code: 'VAULT_NOT_CONFIGURED' });
    } finally {
      process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS = saved;
    }
  });

  it('refuses an unknown token symbol instead of defaulting to one', async () => {
    const r = await verify({ status: 'success', logs: [celoPayment('USDC', '1.2', 'mtn', '08012345678')] }, { tokenSymbol: 'NOPE' });
    expect(r).toMatchObject({ ok: false, code: 'TOKEN_UNKNOWN' });
  });
});
