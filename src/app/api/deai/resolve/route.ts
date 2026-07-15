import { NextResponse } from 'next/server';
import { verifyDeepLink } from '@/lib/deai/deeplink';
import { enforceRateLimit } from '@/lib/rateLimit';

// Public endpoint: the web app calls this to decode a signed DeAI payment link.
// It returns ONLY the payment details to pre-fill the form — no secrets, no funds move.
// The user still connects their own wallet and signs. This is purely a hand-off.
export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'deai-resolve', 30, 60);
  if (limited) return limited;

  try {
    const { payload, sig } = await req.json();

    const result = verifyDeepLink(String(payload || ''), String(sig || ''));
    if (!result.valid) {
      return NextResponse.json({ success: false, message: result.reason }, { status: 400 });
    }

    return NextResponse.json({ success: true, intent: result.intent });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
