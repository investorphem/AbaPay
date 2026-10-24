import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚡ THE NIM RAIL'S CHAIN READER (src/lib/nimiq.ts)
//
// What decides whether a NIM payment buys a real bill: the transfer must reach the treasury,
// carry this order's reference, be at least the quoted luna, come from the ordering wallet and
// be confirmed. The ATTACK cases are a payment made for one order presented for another, and an
// unrelated transfer to the treasury presented as payment.

vi.mock('server-only', () => ({}));

// Real mainnet addresses (valid checksums), used only as fixtures.
const TREASURY = 'NQ36 8QDJ 26LU ABEG 3E84 14NT 4HBB 91GC 36P3';
const PAYER = 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG';
const INTENT = 'preflight_nim_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const HASH = 'f'.repeat(64);

process.env.NIMIQ_TREASURY_ADDRESS = TREASURY;

const nim = await import('@/lib/nimiq');

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
let chainTx: Record<string, unknown> | null;
let rpcDown = false;

const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (rpcDown) throw new Error('ECONNREFUSED');
  const body = JSON.parse(String(init?.body || '{}'));
  if (body.method === 'getTransactionByHash') {
    return new Response(JSON.stringify(chainTx ? { result: { data: chainTx } } : { error: { message: 'not found' } }));
  }
  if (body.method === 'getTransactionsByAddress') {
    return new Response(JSON.stringify({ result: { data: chainTx ? [chainTx] : [] } }));
  }
  return new Response('{}');
});
vi.stubGlobal('fetch', fetchMock);

const paid = (over: Record<string, unknown> = {}) => ({
  hash: HASH, blockNumber: 1, timestamp: 0, confirmations: 30, from: PAYER, to: TREASURY,
  value: 2_431 * nim.LUNA_PER_NIM, fee: 0, recipientData: hex(nim.paymentReference(INTENT)),
  networkId: 24, executionResult: true, ...over,
});

const verify = (over: Partial<{ minLuna: number; intentId: string; payer: string | null }> = {}) =>
  nim.verifyNimPayment(HASH, { minLuna: 2_431 * nim.LUNA_PER_NIM, intentId: INTENT, payer: PAYER, ...over });

beforeEach(() => {
  chainTx = paid();
  rpcDown = false;
  fetchMock.mockClear();
});

describe('addresses', () => {
  it('accepts real addresses with or without spaces, any case', () => {
    expect(nim.isNimAddress(TREASURY)).toBe(true);
    expect(nim.isNimAddress(TREASURY.replace(/ /g, '').toLowerCase())).toBe(true);
  });

  it('rejects a bad checksum, a bad character and the wrong length', () => {
    expect(nim.isNimAddress(TREASURY.replace('NQ36', 'NQ37'))).toBe(false);
    expect(nim.isNimAddress(TREASURY.replace('8QDJ', '8QDO'))).toBe(false); // O isn't in Nimiq's alphabet
    expect(nim.isNimAddress('NQ36 8QDJ')).toBe(false);
    expect(nim.isNimAddress('0x' + 'a'.repeat(40))).toBe(false);
  });

  it('formats in groups of four', () => {
    expect(nim.formatNimAddress(TREASURY.replace(/ /g, ''))).toBe(TREASURY);
  });
});

describe('pricing', () => {
  it('adds the buffer and rounds up to a whole NIM', () => {
    // $0.75 at $0.0003/NIM = 2,500 NIM; +2% = 2,550.
    expect(nim.lunaForUsd(0.75, 0.0003)).toBe(2_550 * nim.LUNA_PER_NIM);
    expect(nim.lunaForUsd(0.0001, 0.0003) % nim.LUNA_PER_NIM).toBe(0);
  });

  it('ties a reference to one intent', () => {
    expect(nim.paymentReference(INTENT)).toBe('abapay:nim_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed');
    expect(new TextEncoder().encode(nim.paymentReference(INTENT)).length).toBeLessThanOrEqual(64);
    // Why the app must send it as PLAIN TEXT: Nimiq Pay stores `data` as UTF-8, so the hex form
    // (what we used to send) would itself be the memo — 94 bytes, over the 64-byte limit, and the
    // payment could never be accepted (stuck "Pending" in Nimiq Pay, 2026-10-17).
    const hexForm = Buffer.from(nim.paymentReference(INTENT), 'utf8').toString('hex');
    expect(new TextEncoder().encode(hexForm).length).toBeGreaterThan(nim.MAX_NIM_MEMO_BYTES);
  });

  it('refuses to issue a reference no Nimiq payment could carry', () => {
    expect(() => nim.paymentReference(`preflight_nim_${'x'.repeat(80)}`)).toThrow(/at most 64/);
  });
});

describe('verifyNimPayment', () => {
  it('accepts a confirmed payment of the quoted amount to the treasury with this order’s reference', async () => {
    expect(await verify()).toMatchObject({ ok: true, tx: { hash: HASH } });
  });

  it('accepts overpayment', async () => {
    chainTx = paid({ value: 3_000 * nim.LUNA_PER_NIM });
    expect((await verify()).ok).toBe(true);
  });

  it('ATTACK: a payment made for another order is refused', async () => {
    chainTx = paid({ recipientData: hex('abapay:nim_someone-elses-order') });
    expect(await verify()).toMatchObject({ ok: false, code: 'REFERENCE_MISMATCH' });
  });

  it('ATTACK: an unrelated transfer to the treasury (no reference) is refused', async () => {
    chainTx = paid({ recipientData: '' });
    expect(await verify()).toMatchObject({ ok: false, code: 'REFERENCE_MISMATCH' });
  });

  it('refuses a payment to another address', async () => {
    chainTx = paid({ to: PAYER });
    expect(await verify()).toMatchObject({ ok: false, code: 'WRONG_RECIPIENT' });
  });

  it('refuses an underpayment by even one luna', async () => {
    chainTx = paid({ value: 2_431 * nim.LUNA_PER_NIM - 1 });
    expect(await verify()).toMatchObject({ ok: false, code: 'AMOUNT_SHORT' });
  });

  it('refuses a payment from a different wallet than the one that ordered', async () => {
    chainTx = paid({ from: TREASURY });
    expect(await verify()).toMatchObject({ ok: false, code: 'SENDER_MISMATCH' });
  });

  it('refuses a failed transaction and a testnet one', async () => {
    chainTx = paid({ executionResult: false });
    expect(await verify()).toMatchObject({ ok: false, code: 'FAILED' });
    chainTx = paid({ networkId: 5 });
    expect(await verify()).toMatchObject({ ok: false, code: 'WRONG_NETWORK' });
  });

  it('is undecided (not a verdict) when unconfirmed, missing or the RPC is down', async () => {
    chainTx = paid({ confirmations: 2 });
    expect(await verify()).toMatchObject({ ok: false, code: 'UNCONFIRMED' });
    chainTx = null;
    expect(await verify()).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    rpcDown = true;
    expect(await verify()).toMatchObject({ ok: false, code: 'RPC_UNAVAILABLE' });
    for (const code of ['UNCONFIRMED', 'NOT_FOUND', 'RPC_UNAVAILABLE'] as const) expect(nim.UNDECIDED_NIM_FAILURES.has(code)).toBe(true);
  });
});

describe('recentTreasuryPayments', () => {
  it('indexes treasury payments by their reference', async () => {
    const byRef = await nim.recentTreasuryPayments();
    expect(byRef?.get(nim.paymentReference(INTENT))?.hash).toBe(HASH);
  });
});

describe('verifyNimRefund', () => {
  const refund = (over: Record<string, unknown> = {}) => paid({ from: TREASURY, to: PAYER, recipientData: '', ...over });

  it('confirms NIM sent from the treasury to the payer', async () => {
    chainTx = refund();
    expect((await nim.verifyNimRefund(HASH, { to: PAYER, minLuna: 2_431 * nim.LUNA_PER_NIM })).status).toBe('CONFIRMED');
  });

  it('refuses a refund to someone else, a short one, and one not from the treasury', async () => {
    chainTx = refund({ to: TREASURY, from: PAYER });
    expect((await nim.verifyNimRefund(HASH, { to: PAYER, minLuna: 1 })).status).toBe('MISMATCH');
    chainTx = refund({ value: 1 });
    expect((await nim.verifyNimRefund(HASH, { to: PAYER, minLuna: 2 })).status).toBe('MISMATCH');
  });

  it('reports a failed refund as FAILED and a missing one as PENDING', async () => {
    chainTx = refund({ executionResult: false });
    expect((await nim.verifyNimRefund(HASH, { to: PAYER, minLuna: 1 })).status).toBe('FAILED');
    chainTx = null;
    expect((await nim.verifyNimRefund(HASH, { to: PAYER, minLuna: 1 })).status).toBe('PENDING');
  });
});
