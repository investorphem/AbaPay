import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createAdminSession, ADMIN_COOKIE } from '@/utils/adminAuth';

// 🔐 ADMIN SIGN-IN (M4.5). The dashboard posts a Sign-In with Ethereum proof (headers
// x-wallet-signature + x-wallet-siwe, action "POST:/api/admin/login") signed by an ops wallet.
// On success the session id goes into an HttpOnly cookie the dashboard never sees. See
// src/utils/adminAuth.ts.

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'admin-login', 10, 600);
  if (limited) return limited;

  const result = await createAdminSession(req);
  if (!result.ok) return NextResponse.json({ success: false, message: result.message }, { status: result.status });

  const res = NextResponse.json({ success: true, address: result.address, expiresInSeconds: result.maxAgeSeconds });
  res.cookies.set(ADMIN_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: result.maxAgeSeconds,
  });
  return res;
}
