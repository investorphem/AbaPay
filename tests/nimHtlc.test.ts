import { describe, it, expect, vi, beforeEach } from 'vitest';

// Nimiq Pay holds a user's NIM in HTLCs their own address funded, and can pay out of them.
// Replays the wallet seen on 2026-10-17: basic balance 0, 6,789.055 NIM in an HTLC it funded
// (Nimiq Pay showed 6,789 NIM; a plain balance read showed 0).

vi.mock('server-only', () => ({}));

const ME = 'NQ65 68XN 4V9C 3BP6 S1N9 HJBA 8XP3 0LQD JRVX';
const HTLC = 'NQ41 339U PJUL 1MV0 VQ6H B9V5 CE7E XSRY F2SS';
const SERVICE = 'NQ14 LU5R UH54 92SH GEN4 U63C SV4V 7N49 YYU4';
const OTHER = 'NQ16 2SSN 82TL SMQS KXT3 Q01V CMAL NU6F 1LJG';
const TREASURY = 'NQ36 8QDJ 26LU ABEG 3E84 14NT 4HBB 91GC 36P3';
const LOCKED = 678_905_500;
const NOW = 1_792_260_000_000;

process.env.NIMIQ_TREASURY_ADDRESS = TREASURY;

let accounts: Record<string, unknown>;
let history: Record<string, unknown[]>;
let txByHash: Record<string, unknown>;
let down = false;

const key = (a: string) => a.replace(/\s+/g, '').toUpperCase();
vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
  if (down) throw new Error('ECONNREFUSED');
  const { method, params } = JSON.parse(String(init?.body || '{}'));
  const ok = (data: unknown) => new Response(JSON.stringify({ result: { data } }));
  if (method === 'getAccountByAddress') return ok(accounts[key(params[0])] ?? { balance: 0, type: 'basic' });
  if (method === 'getTransactionsByAddress') return ok(history[key(params[0])] ?? []);
  if (method === 'getTransactionByHash') return txByHash[params[0]] ? ok(txByHash[params[0]]) : new Response(JSON.stringify({ error: { message: 'not found' } }));
  throw new Error(`unexpected ${method}`);
});

const nim = await import('@/lib/nimiq');

const funding = { from: ME, fromType: 0, to: HTLC, toType: 2, value: LOCKED };
const htlcAccount = (over: Record<string, unknown> = {}) => ({ type: 'htlc', balance: LOCKED, sender: ME, recipient: SERVICE, timeout: NOW + 14 * 86_400_000, ...over });

beforeEach(() => {
  down = false;
  accounts = { [key(ME)]: { balance: 0, type: 'basic' }, [key(HTLC)]: htlcAccount() };
  history = { [key(ME)]: [funding, { from: 'NQ60 S8EH', fromType: 0, to: ME, toType: 0, value: LOCKED }], [key(HTLC)]: [funding] };
  txByHash = {};
});

describe('nimBalanceLuna — counts NIM in HTLCs the wallet funded', () => {
  it('reads 6,789.055 NIM for the Nimiq Pay wallet whose plain balance is 0', async () => {
    expect(await nim.nimBalanceLuna(ME, NOW)).toBe(LOCKED);
  });

  it('adds HTLC funds to a plain balance', async () => {
    accounts[key(ME)] = { balance: 100_000, type: 'basic' };
    expect(await nim.nimBalanceLuna(ME, NOW)).toBe(LOCKED + 100_000);
  });

  it('does not count an expired HTLC, an emptied one, or one someone else funded', async () => {
    accounts[key(HTLC)] = htlcAccount({ timeout: NOW - 1 });
    expect(await nim.nimBalanceLuna(ME, NOW)).toBe(0);
    accounts[key(HTLC)] = { balance: 0, type: 'basic' };
    expect(await nim.nimBalanceLuna(ME, NOW)).toBe(0);
    accounts[key(HTLC)] = htlcAccount({ sender: OTHER });
    expect(await nim.nimBalanceLuna(ME, NOW)).toBe(0);
  });

  it('is null (unknown, never 0) when the chain cannot be read', async () => {
    down = true;
    expect(await nim.nimBalanceLuna(ME, NOW)).toBeNull();
  });
});

describe('verifyNimPayment — a payment out of the payer’s own HTLC is the payer’s', () => {
  const INTENT = 'preflight_nim_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  const HASH = 'e'.repeat(64);
  const pay = (over: Record<string, unknown> = {}) => {
    txByHash[HASH] = {
      hash: HASH, from: HTLC, fromType: 2, to: TREASURY, toType: 0, value: 27_300_000, confirmations: 20, networkId: 24, executionResult: true,
      recipientData: Buffer.from(nim.paymentReference(INTENT), 'utf8').toString('hex'), ...over,
    };
    return nim.verifyNimPayment(HASH, { minLuna: 27_300_000, intentId: INTENT, payer: ME });
  };

  it('accepts it when the chain shows the ordering wallet funded that HTLC', async () => {
    expect(await pay()).toMatchObject({ ok: true });
  });

  it('accepts it from history once the HTLC is emptied (gone from state)', async () => {
    accounts[key(HTLC)] = { balance: 0, type: 'basic' };
    expect(await pay()).toMatchObject({ ok: true });
  });

  it('refuses an HTLC someone else funded', async () => {
    accounts[key(HTLC)] = htlcAccount({ sender: OTHER });
    expect(await pay()).toMatchObject({ ok: false, code: 'SENDER_MISMATCH' });
  });

  it('still refuses a plain transfer from another wallet', async () => {
    expect(await pay({ from: OTHER, fromType: 0 })).toMatchObject({ ok: false, code: 'SENDER_MISMATCH' });
  });

  it('keeps every other check: wrong reference is still refused', async () => {
    expect(await pay({ recipientData: Buffer.from('nope', 'utf8').toString('hex') })).toMatchObject({ ok: false, code: 'REFERENCE_MISMATCH' });
  });
});
