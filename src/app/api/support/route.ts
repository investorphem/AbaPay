import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { enforceRateLimit, enforceRateLimitByKey } from '@/lib/rateLimit';
import { errorMessage } from '@/lib/errors';

/** Tickets one sender (IP, email or wallet) may send per window. */
const SUPPORT_PER_SENDER = 5;
const SUPPORT_WINDOW_SECONDS = 300;
/** Tickets forwarded to the support Telegram per hour across ALL senders. */
const SUPPORT_GLOBAL_PER_HOUR = 20;

const tooMany = () => NextResponse.json(
  { success: false, message: 'Support is receiving a lot of messages right now. Please try again in a few minutes.' },
  { status: 429 },
);

/** The email as a rate-limit key: trimmed, lower-cased and hashed, so the table never holds addresses. */
const emailKey = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);

export async function POST(req: Request) {
  // 🛡️ Prevent ticket spam / notification flooding: 5 per 5 min per IP…
  const limited = await enforceRateLimit(req, 'support', SUPPORT_PER_SENDER, SUPPORT_WINDOW_SECONDS);
  if (limited) return limited;

  try {
    // A body that isn't a form (empty, JSON, junk) is the sender's mistake: 400, not a 500 that
    // reads as "our server failed".
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ success: false, message: 'Invalid request. Please send the support form.' }, { status: 400 });
    }
    const message = formData.get('message') as string;
    const email = formData.get('email') as string; // ⚡ NEW: Catch the email
    const file = formData.get('file') as File;
    const userAddress = formData.get('userAddress') as string;
    const chain = formData.get('chain') as string || 'Unknown';

    // UPGRADED: Catch the hidden transaction hash!
    const txHash = formData.get('txHash') as string;

    // 🛡️ …and 5 per 5 min per email and per wallet, so changing IP (Tor, VPN) doesn't reset the
    // count for the same sender. 2026-11-15: "probe" tickets came from rotating Tor exit nodes
    // (185.220.100.246, 185.220.101.140) and a VPN, each getting a fresh per-IP allowance.
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (cleanEmail && await enforceRateLimitByKey(`support:email:${emailKey(cleanEmail)}`, SUPPORT_PER_SENDER, SUPPORT_WINDOW_SECONDS)) return tooMany();
    const wallet = String(userAddress || '').trim().toLowerCase();
    if (wallet && wallet !== 'anonymous' && await enforceRateLimitByKey(`support:wallet:${wallet}`, SUPPORT_PER_SENDER, SUPPORT_WINDOW_SECONDS)) return tooMany();
    // …and a site-wide cap: real support traffic is a handful a day, so this only bites a flood
    // that rotates IP, email and wallet all at once.
    if (await enforceRateLimitByKey('support:global', SUPPORT_GLOBAL_PER_HOUR, 3600)) return tooMany();

    // 🔐 ABUSE CONTROLS: validate message and attachment before forwarding to Telegram
    if (!message || message.trim().length === 0) {
      return NextResponse.json({ success: false, message: "Message is required." }, { status: 400 });
    }
    if (message.length > 2000) {
      return NextResponse.json({ success: false, message: "Message too long (max 2000 characters)." }, { status: 400 });
    }
    if (file && file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ success: false, message: "Attachment too large (max 5MB)." }, { status: 400 });
    }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
    if (file && file.size > 0 && !allowedTypes.includes(file.type)) {
      return NextResponse.json({ success: false, message: "Unsupported attachment type. Please use an image or PDF." }, { status: 400 });
    }

    // ⚡ CHANGED: Now uses the dedicated Support Bot Token
    const botToken = process.env.SUPPORT_TELEGRAM_BOT_TOKEN;

    // Keeps the original Chat ID logic
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
       console.error("[CRITICAL] Telegram keys missing in .env.local");
       return NextResponse.json({ success: false, message: "Server configuration error." }, { status: 500 });
    }

    // Professional Support Template (Now dynamically includes the Email & Hash)
    const caption = `🎫 *ABAPAY SUPPORT TICKET*\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📧 *Email:* ${email || 'Not provided'}\n` + // ⚡ INJECTED EMAIL HERE
                    `⛓️ *Chain:* ${chain}\n` +          // ⚡ THE NEW CHAIN TAG
                    `👤 *Wallet:* \`${userAddress || 'Anonymous'}\`\n` +
                    (txHash ? `🔗 *TX ID:* \`${txHash}\`\n` : '') +
                    `💬 *Issue:* ${message}\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `⏰ *Time:* ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })} WAT`;

    let tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const tgFormData = new FormData();
    tgFormData.append('chat_id', chatId);
    tgFormData.append('parse_mode', 'Markdown'); // Makes the wallet and hash "tap to copy"

    // File Handling Logic
    if (file && file.size > 0) {
      // Use sendDocument to preserve image quality/PDF data
      tgUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
      tgFormData.append('document', file);
      tgFormData.append('caption', caption);
    } else {
      // Standard Text Message
      tgFormData.append('text', caption);
    }

    const tgResponse = await fetch(tgUrl, { 
        method: 'POST', 
        body: tgFormData 
    });

    if (!tgResponse.ok) {
        const errorData = await tgResponse.json();
        console.error("Telegram Error Details:", errorData);
        throw new Error("Telegram API rejected the payload.");
    }

    return NextResponse.json({ 
        success: true, 
        message: "Your ticket has been sent directly to the AbaPay Admin Team." 
    });

  } catch (error) {
    console.error("Support API Failure:", errorMessage(error));
    return NextResponse.json({ 
        success: false, 
        message: "Failed to dispatch ticket. Please try again or check your connection." 
    }, { status: 500 });
  }
}
