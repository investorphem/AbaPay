import { NextResponse } from 'next/server';
import { revokeAdminSessions, ADMIN_COOKIE } from '@/utils/adminAuth';

// 🔐 ADMIN SIGN-OUT. Body { all: true } signs out every open session for this admin wallet
// (e.g. after using a shared machine, or if a session might have leaked).

export async function POST(req: Request) {
  // Same-site only, like every other state-changing admin request.
  const origin = req.headers.get('origin');
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').toLowerCase();
  let sameSite = false;
  try { sameSite = !!origin && new URL(origin).host.toLowerCase() === host; } catch { /* no */ }
  if (!sameSite) return NextResponse.json({ success: false, message: 'Forbidden: cross-site request.' }, { status: 403 });

  let all = false;
  try { all = (await req.json())?.all === true; } catch { /* no body: just this session */ }
  const { revoked } = await revokeAdminSessions(req, all);

  const res = NextResponse.json({ success: true, revoked });
  res.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
  return res;
}
