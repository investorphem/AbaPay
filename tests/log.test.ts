import { describe, it, expect, vi, afterEach } from 'vitest';
import { log, metric, redact, maskEmail, maskPhone } from '@/lib/log';

// M5: logs must never carry a PIN, an API key, an X-PAYMENT header, a signature or an OTP,
// and contact details are masked. These are the cases the plan names.

afterEach(() => { vi.restoreAllMocks(); delete process.env.LOG_FORMAT; delete process.env.LOG_LEVEL; });

function capture() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(console, 'error').mockImplementation(push);
  return lines;
}

const SECRETS = {
  pin: '482915',
  api_key: 'aba_mcp_supersecretvalue123',
  'X-PAYMENT': 'eyJ4NDAyVmVyc2lvbiI6Mn0=',
  signature: '0x' + 'ab'.repeat(65),
  otp: '771234',
  headers: { authorization: 'Bearer abc.def.ghi', 'x-wallet-siwe': 'base64siwe' },
  nested: { deeper: { private_key: '0x' + '11'.repeat(32) } },
};

describe('log redaction', () => {
  it('never writes any secret value, at any depth', () => {
    const lines = capture();
    log.error('payment.failed', { request_id: 'req-1', ...SECRETS });
    const out = lines.join('\n');
    for (const v of ['482915', 'aba_mcp_supersecretvalue123', 'eyJ4NDAyVmVyc2lvbiI6Mn0=', 'ab'.repeat(65), '771234', 'abc.def.ghi', 'base64siwe', '11'.repeat(32)]) {
      expect(out).not.toContain(v);
    }
    expect(out).toContain('req-1');
    expect(out).toContain('[redacted]');
  });

  it('masks emails and phone numbers', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@e***.com');
    expect(maskPhone('+234 801 234 5678')).toBe('***5678');
    const r = redact({ customer_email: 'jane.doe@example.com', phone: '08012345678' }) as Record<string, string>;
    expect(r.customer_email).toBe('j***@e***.com');
    expect(r.phone).toBe('***5678');
  });

  it('writes one JSON object per line with ts, level and event', () => {
    const lines = capture();
    log.info('payment.verified', { request_id: 'r', rail: 'x402', duration_ms: 12 });
    const obj = JSON.parse(lines[0]);
    expect(obj).toMatchObject({ level: 'info', event: 'payment.verified', request_id: 'r', rail: 'x402', duration_ms: 12 });
    expect(typeof obj.ts).toBe('string');
  });

  it('LOG_FORMAT=plain still redacts', () => {
    process.env.LOG_FORMAT = 'plain';
    const lines = capture();
    log.warn('x', { pin: '482915' });
    expect(lines.join('')).not.toContain('482915');
  });

  it('respects LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    const lines = capture();
    log.info('quiet');
    log.warn('loud');
    expect(lines).toHaveLength(1);
  });

  it('survives cycles and errors', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact({ a, err: new Error('boom') })).not.toThrow();
  });
});

describe('metric', () => {
  it('is a structured metric line', () => {
    const lines = capture();
    metric('vend_outcome_total', 1, { provider: 'VTPASS', outcome: 'delivered' });
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'metric', metric: 'vend_outcome_total', value: 1, labels: { provider: 'VTPASS', outcome: 'delivered' } });
  });
});
