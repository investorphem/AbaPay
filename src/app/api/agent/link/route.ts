import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { hashPin } from '@/utils/pinSecurity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { verifyWalletOwnership } from '@/utils/walletAuth';

// ⚡ SOCIAL LINKING — done in the REAL APP, where the user has their wallet.
//
// Flow:
//   1. In the app: user connects wallet, picks a channel, sets a PIN  -> POST here
//   2. We return a one-time LINK CODE
//   3. User sends that code to the bot on Telegram -> the bot verifies and binds their chat id
//   4. Separately, IN THE APP, the user calls setSpendingAllowance() on-chain from their own
//      wallet to authorise how much the agent may spend. That on-chain cap is the ONLY thing
//      that actually bounds the agent — this table is just UX state.

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'agent-link-read', 60, 60);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const wallet = (searchParams.get('wallet') || '').toLowerCase();

  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ success: false, message: 'Valid wallet address required' }, { status: 400 });
  }

  const { data } = await supabaseAdmin
    .from('agent_links')
    .select('id, channel, channel_user_id, link_verified, approved_token, approved_chain, is_active, created_at')
    .ilike('wallet_address', wallet);

  return NextResponse.json({ success: true, links: data || [] });
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'agent-link-write', 10, 300);
  if (limited) return limited;

  try {
    const { wallet_address, channel, pin, approved_token, approved_chain } = await req.json();
    const wallet = String(wallet_address || '').toLowerCase();

    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return NextResponse.json({ success: false, message: 'Valid wallet address required' }, { status: 400 });
    }
    if (!['TELEGRAM', 'WHATSAPP', 'X'].includes(channel)) {
      return NextResponse.json({ success: false, message: 'Unsupported channel' }, { status: 400 });
    }
    if (!/^\d{4,6}$/.test(String(pin || ''))) {
      return NextResponse.json({ success: false, message: 'PIN must be 4-6 digits' }, { status: 400 });
    }

    // 🔐 Prove the caller actually controls this wallet before binding a chat identity + PIN
    // to it — see src/utils/walletAuth.ts for why a bare address string is not enough.
    const auth = await verifyWalletOwnership(req, wallet);
    if (!auth.ok) {
      return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
    }

    // One-time, cryptographically random link code (never Math.random).
    const linkCode = 'ABA-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    // channel_user_id is unknown until the user messages the bot; we park the code there
    // and the bot claims it on first contact.
    const { error } = await supabaseAdmin.from('agent_links').upsert(
      {
        wallet_address: wallet,
        channel,
        channel_user_id: `PENDING:${linkCode}`,
        pin_hash: hashPin(String(pin)),
        link_code: linkCode,
        link_verified: false,
        approved_token: approved_token || 'USD₮',
        approved_chain: approved_chain || 'CELO',
        failed_pin_attempts: 0,
        locked_until: null,
        is_active: true,
      },
      { onConflict: 'channel,channel_user_id' }
    );

    if (error) {
      console.error('[AgentLink] create failed:', error.message);
      return NextResponse.json({ success: false, message: 'Could not start linking.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      link_code: linkCode,
      instructions: channel === 'TELEGRAM'
        ? `Open the AbaPay bot on Telegram and send this code: ${linkCode}`
        : `Message the AbaPay bot on ${channel} and send this code: ${linkCode}`,
    });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}

// ⚡ CHANGE / RESET PIN — the app itself never asks for the OLD PIN. The wallet connection
// that gets a user into the Agent Hub in the first place IS the authentication here (same
// trust model as DELETE/unlink below) — the chat PIN only ever confirms a payment inside a
// chat session where there's no wallet to sign with. A forgotten PIN and a deliberate PIN
// change are therefore the same operation: prove you hold the wallet, set a new PIN.
export async function PATCH(req: Request) {
  const limited = await enforceRateLimit(req, 'agent-link-write', 10, 300);
  if (limited) return limited;

  try {
    const { id, wallet_address, new_pin } = await req.json();
    const wallet = String(wallet_address || '').toLowerCase();

    if (!id || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return NextResponse.json({ success: false, message: 'Link id and wallet required' }, { status: 400 });
    }
    if (!/^\d{4,6}$/.test(String(new_pin || ''))) {
      return NextResponse.json({ success: false, message: 'PIN must be 4-6 digits' }, { status: 400 });
    }

    // 🔐 THE FIX — this was the most serious gap: without this, anyone who knew a victim's
    // public wallet address (not a secret) could reset their PIN and take over their linked
    // chat identity outright. The wallet connection alone was never actually verified here.
    const auth = await verifyWalletOwnership(req, wallet);
    if (!auth.ok) {
      return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
    }

    // Scoped to the owning wallet — you can only reset the PIN on your own linked channel.
    const { data, error } = await supabaseAdmin
      .from('agent_links')
      .update({
        pin_hash: hashPin(String(new_pin)),
        // Clear any lockout from prior failed attempts — a fresh PIN deserves a fresh count.
        failed_pin_attempts: 0,
        locked_until: null,
      })
      .eq('id', id)
      .ilike('wallet_address', wallet)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[AgentLink] PIN reset failed:', error.message);
      return NextResponse.json({ success: false, message: 'Could not update PIN.' }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ success: false, message: 'That link was not found for this wallet.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'PIN updated.' });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const limited = await enforceRateLimit(req, 'agent-link-write', 10, 300);
  if (limited) return limited;

  try {
    const { id, wallet_address } = await req.json();
    const wallet = String(wallet_address || '').toLowerCase();

    if (!id || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return NextResponse.json({ success: false, message: 'Link id and wallet required' }, { status: 400 });
    }

    const auth = await verifyWalletOwnership(req, wallet);
    if (!auth.ok) {
      return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
    }

    // Scoped to the owning wallet — you can only unlink your own channels.
    const { error } = await supabaseAdmin
      .from('agent_links')
      .delete()
      .eq('id', id)
      .ilike('wallet_address', wallet);

    if (error) {
      return NextResponse.json({ success: false, message: 'Could not unlink.' }, { status: 500 });
    }

    // NOTE: unlinking here does NOT revoke the on-chain allowance. Tell the user to also
    // call setSpendingAllowance(token, 0) from their wallet to fully revoke agent spending.
    return NextResponse.json({
      success: true,
      message: 'Channel unlinked. To fully revoke agent spending, also set your on-chain allowance to 0 in the app.',
    });
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid request' }, { status: 400 });
  }
}
