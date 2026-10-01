import { NextResponse } from 'next/server';
import { generateSiweNonce } from 'viem/siwe';
import { supabaseAdmin } from '@/utils/supabase';
import { enforceRateLimit } from '@/lib/rateLimit';
import { SIWE_ACTION_LIFETIME_MS, SIWE_SESSION_LIFETIME_MS } from '@/lib/siwe';

// 🔐 SIWE NONCES (M4.4) — every Sign-In with Ethereum message carries one of these, and
// src/utils/walletAuth.ts refuses a message whose nonce wasn't issued here, has expired, or (for
// an action) was already used. That is what makes a captured signature worthless.
//
//   GET /api/auth/nonce?purpose=action            one wallet mutation, single use
//   GET /api/auth/nonce?purpose=action&uses=5     one signature covering 5 identical requests
//                                                  (a multi-recipient schedule batch)
//   GET /api/auth/nonce?purpose=session           the read-only sign-in, reusable for 12h
//
// The nonce outlives the message it goes into by a little (+5 min) so a slow wallet prompt
// doesn't strand it; the message's own expiry is what bounds the signature.

export const dynamic = 'force-dynamic';

const MAX_USES = 20;

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'auth-nonce', 30, 60);
  if (limited) return limited;

  const params = new URL(req.url).searchParams;
  const purpose = params.get('purpose') === 'session' ? 'session' : 'action';
  const usesRaw = Number(params.get('uses') || 1);
  const uses = purpose === 'action' && Number.isInteger(usesRaw) && usesRaw >= 1 ? Math.min(usesRaw, MAX_USES) : 1;

  const nonce = generateSiweNonce();
  const lifetime = (purpose === 'session' ? SIWE_SESSION_LIFETIME_MS : SIWE_ACTION_LIFETIME_MS) + 5 * 60_000;
  const expiresAt = new Date(Date.now() + lifetime).toISOString();

  const { error } = await supabaseAdmin.from('auth_nonces').insert({ nonce, purpose, uses_remaining: uses, expires_at: expiresAt });
  if (error) {
    console.error('[auth/nonce] insert failed:', error.message);
    return NextResponse.json({ success: false, message: 'Could not start wallet verification. Please try again.' }, { status: 503 });
  }

  // Opportunistic prune (~1 in 50) keeps the table bounded without a cron.
  if (Math.random() < 0.02) {
    try { await supabaseAdmin.from('auth_nonces').delete().lt('expires_at', new Date().toISOString()); } catch { /* best-effort */ }
  }

  return NextResponse.json(
    { success: true, nonce, purpose, uses, expiresAt },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
