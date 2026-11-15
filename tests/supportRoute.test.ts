import { describe, it, expect, vi, beforeEach } from 'vitest';

// /api/support forwards web-form tickets to the support Telegram. 2026-11-15: "probe" tickets came
// from rotating Tor exit nodes, each IP getting a fresh 5-per-5-minutes allowance. A site-wide cap
// now stops a flood that changes IP; one sender is still held to the per-IP limit.

const counts = new Map<string, number>();
const hit = (key: string, limit: number) => {
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

const send = (ip: string, message = 'my bill was not delivered') => {
  const form = new FormData();
  form.set('message', message);
  form.set('email', 'user@example.com');
  return POST(new Request('http://localhost/api/support', { method: 'POST', headers: { 'x-real-ip': ip }, body: form }));
};

beforeEach(() => {
  counts.clear();
  telegram.mockClear();
  process.env.SUPPORT_TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_ADMIN_CHAT_ID = '-100test';
});

describe('/api/support — flood limits', () => {
  it('forwards a normal ticket', async () => {
    const res = await send('1.1.1.1');
    expect(res.status).toBe(200);
    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it('holds one sender to 5 tickets per window', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await send('2.2.2.2')).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(telegram).toHaveBeenCalledTimes(5);
  });

  it('caps the whole site at 20 an hour, however many IPs the sender rotates through', async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await send(`185.220.101.${i}`)).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    expect(telegram).toHaveBeenCalledTimes(20);
  });
});
