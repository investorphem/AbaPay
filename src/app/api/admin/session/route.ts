import { NextResponse } from 'next/server';
import { verifyAdminRequest } from '@/utils/adminAuth';

// Lets the dashboard ask "am I still signed in?" on load, so a reload inside an open session
// doesn't need a new wallet signature.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  return NextResponse.json(
    { success: auth.authorized, address: auth.address, message: auth.authorized ? undefined : auth.message },
    { status: auth.authorized ? 200 : 401, headers: { 'Cache-Control': 'no-store' } },
  );
}
