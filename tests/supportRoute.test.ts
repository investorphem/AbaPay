import { describe, it, expect, vi, beforeEach } from 'vitest';

// /api/support forwards web-form tickets to the support Telegram. 2026-11-15: "probe" tickets came
// from rotating Tor exit nodes, each IP getting a fresh allowance. Now one sender is held to 5 per
// 5 minutes by IP, by email and by wallet — whichever trips first — and the whole site to 20 an hour.

const counts = new Map<string, number>();
const keys: string[] = [];
const hit = (key: string, limit: number) => {
  keys.push(key);
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return n <= limit ? null : new Response(JSON.stringify({ success: false, error: 'Too many requests.' }), { status: 429 });
};
vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: async (req: Request, scope: string, limit: number) => hit(`${scope}:${req.headers.get('x-real-ip')}`, limit),
  enforceRateLimitByKey: async (key: string, limit: number) => hit(key, limit),
}));

const telegram = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
vi.stubGlobal('fetch', telegram);

const { POST } = await import('@/app/api/support/route');

let n = 0;
const send = (over: { ip?: string; email?: string; wallet?: string } = {}) => {
  n++;
  const form = new FormData();
  form.set('message', 'my bill was not delivered');
  form.set('email', over.email ?? `user${n}@example.com`);
  if (over.wallet) form.set('userAddress', over.wallet);
  return POST(new Request('http://localhost/api/support', { method: 'POST', headers: { 'x-real-ip': over.ip ?? `10.0.0.${n}` }, body: form }));
};
const statuses = async (count: number, over: (i: number) => Parameters<typeof send>[0]) => {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await send(over(i))).status);
  return out;
};

beforeEach(() => {
  counts.clear();
  keys.length = 0;
  telegram.mockClear();
  process.env.SUPPORT_TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_ADMIN_CHAT_ID = '-100test';
});

describe('/api/support — flood limits', () => {
  it('forwards a normal ticket', async () => {
    expect((await send()).status).toBe(200);
    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it('holds one IP to 5 per window', async () => {
    const s = await statuses(7, () => ({ ip: '2.2.2.2' }));
    expect(s.filter((x) => x === 429)).toHaveLength(2);
    expect(telegram).toHaveBeenCalledTimes(5);
  });

  it('holds one email to 5 per window even from different IPs and in different letter case', async () => {
    const s = await statuses(7, (i) => ({ ip: `185.220.101.${i}`, email: i % 2 ? ' I147@Example.com ' : 'i147@example.com' }));
    expect(s.filter((x) => x === 200)).toHaveLength(5);
    expect(telegram).toHaveBeenCalledTimes(5);
  });

  it('holds one wallet to 5 per window even from different IPs and emails', async () => {
    const s = await statuses(7, (i) => ({ ip: `45.13.225.${i}`, wallet: i % 2 ? '0x633DBA1A00000000000000000000000000000000' : '0x633dba1a00000000000000000000000000000000' }));
    expect(s.filter((x) => x === 200)).toHaveLength(5);
  });

  it('does not count "Anonymous" as a wallet', async () => {
    const s = await statuses(6, () => ({ wallet: 'Anonymous' }));
    expect(s.every((x) => x === 200)).toBe(true);
  });

  it('stores the email only as a hash', async () => {
    await send({ email: 'someone@example.com' });
    expect(keys.some((k) => k.includes('someone@example.com'))).toBe(false);
    expect(keys.some((k) => /^support:email:[0-9a-f]{32}$/.test(k))).toBe(true);
  });

  it('caps the whole site at 20 an hour when IP, email and wallet all rotate, and gives no email address', async () => {
    const res: Response[] = [];
    for (let i = 0; i < 25; i++) res.push(await send({ wallet: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
    expect(res.filter((r) => r.status === 200)).toHaveLength(20);
    const body = await res[24].json();
    expect(res[24].status).toBe(429);
    expect(JSON.stringify(body)).not.toMatch(/@/);
    expect(telegram).toHaveBeenCalledTimes(20);
  });
});
