import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, fakeSupabase, type FakeDb } from './helpers/fakeSupabase';

// MCP get_payment_status: one payment by tx hash or request id, scoped to the caller's wallet.

let db: FakeDb;
vi.mock('server-only', () => ({}));
vi.mock('@/utils/supabase', () => ({ get supabaseAdmin() { return fakeSupabase(db); } }));
vi.mock('@/lib/telegram', () => ({ sendTelegramAlert: async () => {}, sendTelegramToUser: async () => {} }));
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({}) }; } }));
vi.mock('@/lib/deai/receiptCard', () => ({ renderReceiptImage: async () => null, renderHistoryStatementImage: async () => null }));
vi.mock('@/lib/deai/relayer', () => ({ getRemainingAllowance: async () => 0, getMaxAgentPayment: async () => 0 }));
vi.mock('@/lib/deai/batch', () => ({ checkAutonomousCapacity: async () => ({}), groupByChainToken: () => [], executeAgentPayment: async () => ({}) }));

import { callTool as callToolRaw, NEEDS_AUTH, type ToolResult } from '@/lib/deai/mcpTools';
import type { McpIdentity } from '@/lib/deai/mcpAuth';

// Every case here supplies an identity, so NEEDS_AUTH would itself be a failure. The fixture is a
// partial identity (only the fields these tools read), asserted to the full type here, once.
const callTool = async (name: string, args: Record<string, unknown>, identity: object): Promise<ToolResult> => {
  const r = await callToolRaw(name, args, identity as McpIdentity);
  if (r === NEEDS_AUTH) throw new Error('unexpected NEEDS_AUTH');
  return r;
};

const MINE = '0xabc0000000000000000000000000000000000001';
const OTHER = '0xdef0000000000000000000000000000000000002';
const H1 = '0x' + '1'.repeat(64);
const H2 = '0x' + '2'.repeat(64);
const H3 = '0x' + '3'.repeat(64);
const identity = { id: 'link-1', wallet_address: MINE, approved_token: 'USDC', approved_chain: 'BASE', is_active: true, link_verified: true, failed_pin_attempts: 0, locked_until: null, pin_hash: 'x' };
const text = (r: ToolResult) => String((r.content[0] as { text?: string } | undefined)?.text || '');

beforeEach(() => {
  db = createFakeDb({
    transactions: [
      { tx_hash: H1, request_id: 'REQ-1', wallet_address: MINE, status: 'SUCCESS', network: 'mtn', service_category: 'AIRTIME', amount_naira: 500, account_number: '08012345678', blockchain: 'BASE', purchased_code: 'SECRET-TOKEN' },
      { tx_hash: H2, request_id: 'REQ-2', wallet_address: MINE, status: 'FAILED_VENDING', network: 'ikeja', service_category: 'ELECTRICITY', amount_naira: 2000, account_number: '4500', blockchain: 'CELO' },
      { tx_hash: H3, request_id: 'REQ-3', wallet_address: OTHER, status: 'SUCCESS', network: 'glo', service_category: 'AIRTIME', amount_naira: 100, account_number: '0805', blockchain: 'BASE' },
    ],
    refund_queue: [{ tx_hash: H2, status: 'PENDING', refund_tx_hash: null }],
  });
});

describe('get_payment_status', () => {
  it('finds the caller\'s payment by tx hash and explains the status', async () => {
    const r = await callTool('get_payment_status', { reference: H1 }, identity);
    expect(r?.isError).toBeFalsy();
    expect(text(r)).toMatch(/SUCCESS — Delivered/);
    expect(text(r)).not.toContain('SECRET-TOKEN'); // the purchased token is never returned
  });

  it('finds it by request id, with the refund state', async () => {
    const r = await callTool('get_payment_status', { reference: 'REQ-2' }, identity);
    expect(text(r)).toMatch(/FAILED_VENDING/);
    expect(text(r)).toMatch(/Refund: PENDING/);
  });

  it('treats another wallet\'s payment as not found', async () => {
    const r = await callTool('get_payment_status', { reference: H3 }, identity);
    expect(r?.isError).toBe(true);
    expect(text(r)).toMatch(/No payment/);
  });

  it('matches a hash regardless of letter case', async () => {
    const mixed = '0x' + 'A'.repeat(64);
    db.tables.transactions.push({ tx_hash: mixed.toLowerCase(), wallet_address: MINE, status: 'PROCESSING', network: 'mtn', service_category: 'DATA', amount_naira: 1000, account_number: '0801', blockchain: 'BASE' });
    const r = await callTool('get_payment_status', { reference: mixed }, identity);
    expect(text(r)).toMatch(/PROCESSING — Paid/);
  });

  it('requires a reference', async () => {
    expect((await callTool('get_payment_status', {}, identity))?.isError).toBe(true);
  });
});

describe('unknown tools', () => {
  it('get an error result naming the tool, not a null result', async () => {
    const r = await callTool('no_such_tool', {}, identity);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('Unknown tool "no_such_tool"');
  });
});

describe('verified agents\' bank transfers over MCP', () => {
  const HB = '0x' + 'b'.repeat(64);
  const VERIFIED = { present: true as const, status: 'verified' as const, agentAddress: '0xAbC0000000000000000000000000000000000001', agentId: '205' };

  it('get_payment_status returns the transfer reference and the receipt image once sent', async () => {
    const { toBytea } = await import('@/lib/bankPayouts');
    db.tables.transactions.push({ tx_hash: HB, request_id: 'REQ-B', wallet_address: MINE, status: 'SUCCESS', network: 'Access Bank', service_category: 'BANK', service_id: 'abapay-bank-payout', amount_naira: 250000, account_number: '0123456789', blockchain: 'CELO', purchased_code: 'Bank transfer reference: NIP-0001' });
    db.tables.bank_payouts = [{ tx_hash: HB, status: 'PAID', payout_reference: 'NIP-0001', paid_at: '2026-11-21T10:00:00Z', account_name: 'ADA OBI', account_number: '0123456789', bank_name: 'Access Bank', proof_mime: 'image/png', proof_image: toBytea(Buffer.from('png!')) }];
    const r = await callTool('get_payment_status', { reference: HB }, identity);
    expect(text(r)).toMatch(/Reference: NIP-0001/);
    expect(text(r)).toMatch(/ADA OBI/);
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from('png!').toString('base64') });
  });

  it('pay_bank_transfer refuses an agent without a verified Self Agent ID, before the PIN or any money', async () => {
    const r = await callTool('pay_bank_transfer', { pin: '123456', bank_code: '044', account_number: '0123456789', amount_ngn: 5000 }, identity);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/only available to agents with a verified Self Agent ID/);
  });

  it('pay_bank_transfer refuses a verified agent while the operator has bank transfers off', async () => {
    const { runWithSelfAgent } = await import('@/lib/selfAgent');
    const { clearAgentPolicyCache } = await import('@/lib/agentPolicy');
    clearAgentPolicyCache();
    db.tables.platform_settings = [{ id: 1, exchange_rate: 1340, verified_agent_bank_enabled: false }];
    const r = await runWithSelfAgent(VERIFIED, () => callTool('pay_bank_transfer', { pin: '123456', bank_code: '044', account_number: '0123456789', amount_ngn: 5000 }, identity));
    expect(text(r)).toMatch(/switched off/);
    clearAgentPolicyCache();
    db.tables.platform_settings = [{ id: 1, exchange_rate: 1340, verified_agent_bank_enabled: true }];
    const past = await runWithSelfAgent(VERIFIED, () => callTool('pay_bank_transfer', { pin: '123456', bank_code: '044', account_number: '0123456789', amount_ngn: 5000 }, identity));
    expect(text(past)).not.toMatch(/Self Agent ID|switched off/); // past the Self gate: now the PIN decides
  });
});
