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

// 🔴 EVERY ATTEMPT IS SPENT BEFORE THE PIN IS CHECKED. checkPinAllowed() reserves one attempt
// atomically (pin_attempt_reserve, migration 029: row lock, counter + 1, lockout set on the
// 5th/10th/… attempt from the ladder 1m, 5m, 30m, 2h, 24h). The old code read the counter,
// verified the PIN and only then wrote "counter + 1" back, so a parallel burst of wrong PINs
// all saw 0 and all got checked. Now at most 5 guesses reach scrypt between lockouts however
// many arrive at once, and a correct PIN clears the counter (clearPinFailures).
//
// 🔴 FAILS CLOSED. If the counter can't be reserved (DB unreachable, function missing), the
// attempt is refused. Letting it through would hand out uncounted guesses exactly when the
// counter isn't being kept.

export interface PinGate {
  allowed: boolean;
  message?: string;
  attemptsLeft?: number;
  /** Set by checkPinAllowed on the attempt it reserved: the lockout minutes if THIS attempt
   *  was the one that started a lockout (so exactly one caller sends the security alert). */
  lockedMinutes?: number;
  attempts?: number;
  /** Refused because the counter couldn't be reached, not because of a lockout — the caller
   *  should keep the pending request so the user can simply retry. */
  unavailable?: boolean;
}

const UNAVAILABLE: PinGate = {
  allowed: false,
  unavailable: true,
  message: "⚠️ PIN checks are temporarily unavailable, so nothing was charged. Please try again in a minute.",
};

function lockedFor(until: string | Date): string {
  const mins = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  return mins >= 60 ? `${Math.round(mins / 60)} hour${mins >= 120 ? 's' : ''}` : `${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * Reserve one PIN attempt for this identity, or refuse it (locked, or the counter is
 * unavailable). Call it immediately before verifying the PIN, and pass the result to
 * recordPinFailure if the PIN turns out wrong.
 */
export async function checkPinAllowed(linkId: string): Promise<PinGate> {
  try {
    const { data, error } = await supabaseAdmin.rpc('pin_attempt_reserve', { p_link_id: linkId });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      console.error('[PinSecurity] reserve failed:', error?.message || 'no row');
      return UNAVAILABLE;
    }

    const attempts = Number(row.attempts || 0);
    if (!row.allowed) {
      if (!row.locked_until) return UNAVAILABLE; // unknown identity — never an uncounted guess
      return {
        allowed: false,
        attempts,
        message: `🔒 *Locked.*\n\nToo many incorrect PINs. Try again in *${lockedFor(row.locked_until)}*.\n\n_If this wasn't you, someone may have access to this chat. Revoke your agent limit immediately in the AbaPay app._`,
      };
    }

    const lockedMinutes = row.locked_now && row.locked_until
      ? Math.max(1, Math.round((new Date(row.locked_until).getTime() - Date.now()) / 60000))
      : undefined;
    return { allowed: true, attempts, lockedMinutes, attemptsLeft: MAX_ATTEMPTS - (attempts % MAX_ATTEMPTS || MAX_ATTEMPTS) };
  } catch (err) {
    console.error('[PinSecurity] check failed:', err);
    return UNAVAILABLE;
  }
}

/**
 * Report a wrong PIN on an attempt checkPinAllowed already reserved (the counter was
 * incremented there — this does not count it again). Returns the message for the user and,
 * for the attempt that started a lockout, alerts the user and the operator.
 */
export async function recordPinFailure(linkId: string, chatId: string, channel: string, gate?: PinGate): Promise<PinGate> {
  try {
    const { data } = await supabaseAdmin
      .from('agent_links')
      .select('failed_pin_attempts, locked_until, wallet_address')
      .eq('id', linkId)
      .maybeSingle();

    const attempts = gate?.attempts ?? Number(data?.failed_pin_attempts || 0);
    const lockedUntil = data?.locked_until;
    const isLocked = !!lockedUntil && new Date(lockedUntil).getTime() > Date.now();

    if (gate?.lockedMinutes || isLocked) {
      if (!gate?.lockedMinutes) {
        // Another attempt in flight started this lockout and sends the alert; just say so.
        return { allowed: false, message: `🔒 *Locked for ${lockedFor(lockedUntil)}.*\n\nToo many incorrect PINs.` };
      }
      const minutes = gate.lockedMinutes;

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
          `🔒 *PIN LOCKOUT*\n📲 ${channel}\n👤 \`${String(data?.wallet_address || '').slice(0, 10)}...\`\n🔢 ${attempts} failed attempts\n⏱ Locked ${minutes}m`
        );
      } catch { /* best-effort */ }

      return {
        allowed: false,
        message: `🔒 *Locked for ${minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes} minutes`}.*\n\nToo many incorrect PINs.\n\n_If this wasn't you, revoke your agent limit in the AbaPay app immediately._`,
      };
    }

    const left = MAX_ATTEMPTS - (attempts % MAX_ATTEMPTS);
    return {
      allowed: true,
      attemptsLeft: left,
      message: `❌ *Incorrect PIN* — ${left} attempt${left === 1 ? '' : 's'} left before lockout.`,
    };
  } catch (err) {
    // The attempt was already counted by checkPinAllowed, so a failure here loses only the
    // wording, never the count.
    console.error('[PinSecurity] recordFailure error:', err);
    return { allowed: true, message: '❌ *Incorrect PIN.*' };
  }
}

/** Wipe the failure counter (and any lockout) after a correct PIN. */
export async function clearPinFailures(linkId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc('pin_attempt_clear', { p_link_id: linkId });
    if (error) console.error('[PinSecurity] clear failed:', error.message);
  } catch (err) {
    console.error('[PinSecurity] clear failed:', err);
  }
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

    for (const l of (links || []) as { channel: string; channel_user_id: string }[]) {
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

    const email = tx?.customer_email;
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
