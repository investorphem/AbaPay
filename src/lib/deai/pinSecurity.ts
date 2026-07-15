import 'server-only';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramToUser, sendTelegramAlert } from '@/lib/telegram';

// ⚡ PIN SECURITY — brute-force defence that actually works.
//
// 🔴 THE HOLE THIS CLOSES:
// The old counter lived in `deai_sessions.intent_data.pin_attempts`. After 4 wrong PINs it
// DELETED THE SESSION and told the user to "type Start to begin a new request" — which
// created a fresh session with the counter back at zero.
//
// So an attacker with access to someone's Telegram could try 4 PINs, type "Start", try 4
// more, forever. A 4-digit PIN is 10,000 combinations. That is not a lockout; it is a
// speed bump.
//
// The counter must live on the IDENTITY (agent_links), not the session — so it survives
// session resets, "Start", "Cancel", and anything else the attacker tries.

const MAX_ATTEMPTS = 5;

// Escalating lockouts. A legitimate user who fat-fingers their PIN twice is barely
// inconvenienced; someone grinding through the keyspace is stopped cold.
const LOCKOUT_LADDER_MINUTES = [1, 5, 30, 120, 1440]; // 1m, 5m, 30m, 2h, 24h

export interface PinGate {
  allowed: boolean;
  message?: string;
  attemptsLeft?: number;
}

/**
 * Can this identity attempt a PIN right now?
 */
export async function checkPinAllowed(linkId: string): Promise<PinGate> {
  try {
    const { data } = await supabaseAdmin
      .from('agent_links')
      .select('failed_pin_attempts, locked_until')
      .eq('id', linkId)
      .maybeSingle();

    if (!data) return { allowed: true };

    const d = data as any;

    if (d.locked_until) {
      const until = new Date(d.locked_until).getTime();
      const now = Date.now();

      if (now < until) {
        const mins = Math.ceil((until - now) / 60000);
        return {
          allowed: false,
          message: `🔒 *Locked.*\n\nToo many incorrect PINs. Try again in *${mins} minute${mins === 1 ? '' : 's'}*.\n\n_If this wasn't you, someone may have access to this chat. Revoke your agent limit immediately in the AbaPay app._`,
        };
      }

      // Lockout expired — clear it, but KEEP the failure count so the next lockout is longer.
      await supabaseAdmin.from('agent_links').update({ locked_until: null }).eq('id', linkId);
    }

    const used = Number(d.failed_pin_attempts || 0);
    return { allowed: true, attemptsLeft: Math.max(0, MAX_ATTEMPTS - used) };
  } catch (err) {
    console.error('[PinSecurity] check failed:', err);
    return { allowed: true }; // never lock a legitimate user out because of a DB hiccup
  }
}

/**
 * Record a wrong PIN. Locks the identity when the threshold is hit, with escalating duration.
 */
export async function recordPinFailure(linkId: string, chatId: string, channel: string): Promise<PinGate> {
  try {
    const { data } = await supabaseAdmin
      .from('agent_links')
      .select('failed_pin_attempts, wallet_address')
      .eq('id', linkId)
      .maybeSingle();

    const prev = Number((data as any)?.failed_pin_attempts || 0);
    const attempts = prev + 1;

    if (attempts >= MAX_ATTEMPTS) {
      // How many times have they been locked out before? Escalate accordingly.
      const lockoutIndex = Math.min(
        Math.floor(attempts / MAX_ATTEMPTS) - 1,
        LOCKOUT_LADDER_MINUTES.length - 1
      );
      const minutes = LOCKOUT_LADDER_MINUTES[lockoutIndex];
      const until = new Date(Date.now() + minutes * 60_000);

      await supabaseAdmin
        .from('agent_links')
        .update({ failed_pin_attempts: attempts, locked_until: until.toISOString() })
        .eq('id', linkId);

      // ⚡ TELL THE USER SOMEONE IS GUESSING AT THEIR PIN.
      // If their account is compromised, silence is the worst thing we can do.
      const warning =
        `🚨 *Security alert*\n\n` +
        `${attempts} incorrect PIN attempts on your AbaPay agent.\n\n` +
        `Locked for *${minutes >= 60 ? `${Math.round(minutes / 60)} hour${minutes >= 120 ? 's' : ''}` : `${minutes} minute${minutes === 1 ? '' : 's'}`}*.\n\n` +
        `*If this wasn't you, someone has access to this chat.*\n` +
        `→ Set your agent spend limit to *0* in the AbaPay app right now.\n` +
        `→ Then unlink this channel and re-link with a new PIN.`;

      try {
        if (channel === 'TELEGRAM') await sendTelegramToUser(chatId, warning);
      } catch { /* best-effort */ }

      // And tell the operator — repeated lockouts on one identity is an attack signal.
      try {
        await sendTelegramAlert(
          `🔒 *PIN LOCKOUT*\n📲 ${channel}\n👤 \`${String((data as any)?.wallet_address || '').slice(0, 10)}...\`\n🔢 ${attempts} failed attempts\n⏱ Locked ${minutes}m`
        );
      } catch { /* best-effort */ }

      return {
        allowed: false,
        message: `🔒 *Locked for ${minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes} minutes`}.*\n\nToo many incorrect PINs.\n\n_If this wasn't you, revoke your agent limit in the AbaPay app immediately._`,
      };
    }

    await supabaseAdmin
      .from('agent_links')
      .update({ failed_pin_attempts: attempts })
      .eq('id', linkId);

    const left = MAX_ATTEMPTS - attempts;
    return {
      allowed: true,
      attemptsLeft: left,
      message: `❌ *Incorrect PIN* — ${left} attempt${left === 1 ? '' : 's'} left before lockout.`,
    };
  } catch (err) {
    console.error('[PinSecurity] recordFailure error:', err);
    return { allowed: true };
  }
}

/** Wipe the failure counter after a correct PIN. */
export async function clearPinFailures(linkId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from('agent_links')
      .update({ failed_pin_attempts: 0, locked_until: null })
      .eq('id', linkId);
  } catch { /* non-fatal */ }
}

import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy_key_for_build');

export interface SpendAlert {
  amountNgn: number;
  amountCrypto: string;
  token: string;
  service: string;
  account: string;
  channel: string;   // where the spend was initiated from
  txHash: string;
  remaining: string;
}

/**
 * 🔒 OUT-OF-BAND SPEND ALERT — the real defence against third-party chat access.
 *
 * THE THREAT: someone gets into a user's Telegram (stolen phone, hijacked session, shoulder-
 * surfed PIN). They now know the PIN and can spend up to the on-chain allowance.
 *
 * We cannot prevent that from inside Telegram — if you control the chat, you control the
 * chat. What we CAN do is make it impossible to do quietly: the owner is notified by EMAIL
 * and on EVERY OTHER linked channel, immediately, every time the agent spends.
 *
 * So an attacker gets, at most, the user's chosen allowance — and the user finds out within
 * seconds and can revoke (set limit to 0) before it recurs. Silence is what turns a small
 * compromise into a large one.
 */
export async function notifySpendOutOfBand(walletAddress: string, alert: SpendAlert): Promise<void> {
  if (!walletAddress) return;

  const body =
    `💳 *Agent payment made*\n\n` +
    `${alert.service} — ₦${alert.amountNgn.toLocaleString()} (${alert.amountCrypto} ${alert.token})\n` +
    `📱 ${alert.account}\n` +
    `📲 Initiated from: *${alert.channel}*\n\n` +
    `💰 Remaining limit: ${alert.remaining} ${alert.token}\n\n` +
    `⚠️ *Didn't do this?* Someone may have access to your ${alert.channel}.\n` +
    `→ Set your agent limit to *0* in the AbaPay app immediately.`;

  try {
    // Alert on every OTHER linked channel (not the one it came from — they already saw it).
    const { data: links } = await supabaseAdmin
      .from('agent_links')
      .select('channel, channel_user_id')
      .ilike('wallet_address', walletAddress)
      .eq('link_verified', true)
      .eq('is_active', true);

    for (const l of (links || []) as any[]) {
      if (l.channel === alert.channel) continue;   // don't echo back to the source
      if (l.channel === 'TELEGRAM') {
        try { await sendTelegramToUser(l.channel_user_id, body); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }

  // Email is the important one — it's the channel an attacker is least likely to also control.
  try {
    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('customer_email')
      .ilike('wallet_address', walletAddress)
      .not('customer_email', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const email = (tx as any)?.customer_email;
    if (!email) return;

    await resend.emails.send({
      from: 'AbaPay Security <security@abapays.com>',
      to: email,
      replyTo: 'support@abapays.com',
      subject: `Agent payment: ₦${alert.amountNgn.toLocaleString()} — was this you?`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;">
        <h2 style="margin:0 0 12px;">💳 Agent payment made</h2>
        <p style="color:#334155;"><strong>${alert.service}</strong> — ₦${alert.amountNgn.toLocaleString()} (${alert.amountCrypto} ${alert.token})</p>
        <p style="color:#64748b;">To: ${alert.account}<br/>Initiated from: <strong>${alert.channel}</strong></p>
        <p style="color:#64748b;">Remaining agent limit: ${alert.remaining} ${alert.token}</p>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-top:20px;">
          <p style="margin:0;color:#991b1b;font-size:13px;">
            <strong>Didn't do this?</strong> Someone may have access to your ${alert.channel}.<br/>
            Set your agent spend limit to <strong>0</strong> in the AbaPay app immediately — that revokes it on-chain, instantly.
          </p>
        </div>
      </div>`,
    });
  } catch { /* best-effort */ }
}
