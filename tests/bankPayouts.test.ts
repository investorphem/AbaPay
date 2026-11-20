import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// A verified agent's bank transfer (src/lib/bankPayouts.ts): never sent to a provider; queued once
// for the operator; recorded as sent with a reference and receipt, or refunded.

vi.mock('server-only', () => ({}));
let db: FakeDb;
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
const alerts: string[] = [];
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async (t: string) => { alerts.push(t); } }));
const refunds: unknown[] = [];
vi.mock('@/lib/refunds', () => ({ enqueueRefund: async (p: unknown) => { refunds.push(p); return { queued: true }; } }));

const { queueBankPayout, markBankPayoutPaid, refundBankPayout, decodeProof, MANUAL_BANK_SERVICE_ID, fromBytea } = await import('@/lib/bankPayouts');

const TX = `0x${'ab'.repeat(32)}`;
const order = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1', tx_hash: TX, status: 'PROCESSING', wallet_address: '0x1111111111111111111111111111111111111111',
  service_category: 'BANK', service_id: MANUAL_BANK_SERVICE_ID, amount_naira: 250000, amount_usdt: 190, token_used: 'USDC',
  account_number: '0123456789', variation_code: '044', network: 'Access Bank', customer_name: 'ADA OBI',
  self_agent_id: '205', self_agent_address: '0xabc', blockchain: 'CELO', source_channel: 'AGENT', ...over,
});
const vendInput = { vtRequestId: 'r1', txHash: TX, serviceID: MANUAL_BANK_SERVICE_ID, serviceCategory: 'BANK', network: '', billersCode: '0123456789', amount: 190, vendAmount: 250000 };

beforeEach(() => {
  db = createFakeDb({ transactions: [order()], bank_payouts: [] });
  db.unique.bank_payouts = ['transaction_id'];
  alerts.length = 0; refunds.length = 0;
});

describe('queueBankPayout', () => {
  it('queues a paid order for the operator once, with the transfer details, and never asks a provider', async () => {
    const r = await queueBankPayout(vendInput);
    expect(r).toMatchObject({ success: true, status: 'AWAITING_PAYOUT' });
    expect(db.tables.transactions[0].status).toBe('AWAITING_PAYOUT');
    expect(db.tables.bank_payouts).toEqual([expect.objectContaining({
      transaction_id: 'tx-1', amount_ngn: 250000, bank_code: '044', bank_name: 'Access Bank', account_number: '0123456789',
      account_name: 'ADA OBI', self_agent_id: '205', status: 'AWAITING',
    })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/BANK PAYOUT TO SEND[\s\S]*₦250,000[\s\S]*0123456789[\s\S]*ADA OBI/);

    // A second delivery path reaching the same order: already in hand, no second row, no second alert.
    expect(await queueBankPayout(vendInput)).toMatchObject({ status: 'AWAITING_PAYOUT' });
    expect(db.tables.bank_payouts).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('does not queue an order that is not proven paid yet', async () => {
    db.tables.transactions = [order({ status: 'PENDING' })];
    expect(await queueBankPayout(vendInput)).toMatchObject({ status: 'TIMEOUT' });
    expect(db.tables.bank_payouts).toHaveLength(0);
    expect(db.tables.transactions[0].status).toBe('PENDING');
  });

  it('refunds instead of paying out an order with no verified Self Agent ID on it', async () => {
    db.tables.transactions = [order({ self_agent_id: null })];
    expect(await queueBankPayout(vendInput)).toMatchObject({ status: 'FAILED_VENDING' });
    expect(db.tables.bank_payouts).toHaveLength(0);
    expect(refunds).toHaveLength(1);
  });
});

describe('recording the payout', () => {
  const PNG = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

  it('marks it sent with the reference and receipt, and the order delivered', async () => {
    await queueBankPayout(vendInput);
    const id = String(db.tables.bank_payouts[0].id);
    const r = await markBankPayoutPaid({ payoutId: id, reference: 'NIP-0001', proof: decodeProof(PNG), admin: '0xAdmin' });
    expect(r).toEqual({ ok: true });
    expect(db.tables.bank_payouts[0]).toMatchObject({ status: 'PAID', payout_reference: 'NIP-0001', proof_mime: 'image/png', paid_by: '0xadmin' });
    expect(fromBytea(db.tables.bank_payouts[0].proof_image)?.toString()).toBe('fake-png-bytes');
    expect(db.tables.transactions[0]).toMatchObject({ status: 'SUCCESS', purchased_code: 'Bank transfer reference: NIP-0001' });
    expect(await markBankPayoutPaid({ payoutId: id, reference: 'again', proof: null, admin: '0xAdmin' })).toMatchObject({ ok: false });
  });

  it('requires a reference', async () => {
    await queueBankPayout(vendInput);
    expect(await markBankPayoutPaid({ payoutId: String(db.tables.bank_payouts[0].id), reference: '  ', proof: null, admin: 'a' })).toMatchObject({ ok: false });
  });

  it('refunds a transfer that will not be sent', async () => {
    await queueBankPayout(vendInput);
    const r = await refundBankPayout({ payoutId: String(db.tables.bank_payouts[0].id), reason: 'Account closed', admin: 'a' });
    expect(r).toEqual({ ok: true });
    expect(db.tables.bank_payouts[0].status).toBe('REFUNDED');
    expect(db.tables.transactions[0]).toMatchObject({ status: 'FAILED_VENDING', error_code: 'BANK_PAYOUT_NOT_SENT' });
    expect(refunds).toEqual([expect.objectContaining({ txHash: TX, amountCrypto: 190, reason: 'Account closed' })]);
  });

  it('accepts only small images and PDFs as receipts', () => {
    expect(decodeProof(PNG)?.mime).toBe('image/png');
    expect(decodeProof('data:text/html;base64,PGgxPg==')).toBeNull();
    expect(decodeProof(`data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`)).toBeNull();
  });
});
