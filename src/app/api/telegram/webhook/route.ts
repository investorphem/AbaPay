// src/app/api/telegram/webhook/route.ts
import { NextResponse } from 'next/server';
import { internalAuthHeaders } from '@/utils/internalAuth';

// ⚡ CHANGED: Now explicitly uses the DEAI token, completely ignoring the Admin token
const DEAI_BOT_TOKEN = process.env.DEAI_TELEGRAM_BOT_TOKEN as string;

// Must match the bot's real @username (see AgentHub.tsx's CHANNELS constant) — used to
// detect an explicit @mention in a group chat, below.
const BOT_USERNAME = 'abapayagentbot';

export async function POST(req: Request) {
  try {
    // 🔐 WEBHOOK AUTH: verify Telegram's secret token. Register it once with:
    // setWebhook?url=...&secret_token=<TELEGRAM_WEBHOOK_SECRET>. Enforced when configured.
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      const providedSecret = req.headers.get('x-telegram-bot-api-secret-token');
      if (providedSecret !== webhookSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // Dynamically grab your live domain (works on localhost AND Vercel automatically)
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const CORE_ENGINE_URL = `${protocol}://${host}/api/deai/core`;

    const body = await req.json();
    let text = body.message?.text || "";
    const chatId = body.message?.chat?.id?.toString();
    const chatType = body.message?.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'
    // 🔴 THE BUG: `chatId` is the CONVERSATION's id — in a private DM that happens to equal
    // the sender's own id, which is why this worked so far. In a GROUP, `chatId` is the same
    // for every member, so every person in the group was being resolved to whichever ONE
    // wallet happened to be linked against that shared chat id — a real cross-user identity
    // mix-up, not just a cosmetic bug. The message SENDER is `message.from.id`, always unique
    // per person regardless of which chat they sent it in — that's the actual identity.
    const senderId = body.message?.from?.id?.toString();
    const messageId = body.message?.message_id;

    if (!text || !senderId) return NextResponse.json({ success: true });

    // ⚡ GROUP/CHANNEL GATING — only act on a group message that's clearly addressed to the
    // bot (mentions @<bot username> or replies to one of the bot's own messages). Telegram's
    // default "privacy mode" already limits what a group forwards to a bot, but this is a
    // second, explicit guard so a busy group's ordinary chatter never gets mis-parsed as a
    // payment request. Never applies in a private 1:1 chat.
    if (chatType && chatType !== 'private') {
      const mentionsBot = text.toLowerCase().includes(`@${BOT_USERNAME}`);
      const repliesToBot = body.message?.reply_to_message?.from?.is_bot === true;
      if (!mentionsBot && !repliesToBot) {
        return NextResponse.json({ success: true });
      }
      // Strip the mention itself so the intent parser sees clean text, e.g.
      // "@AbaPayAgentBot recharge me 500 mtn" -> "recharge me 500 mtn".
      text = text.replace(new RegExp(`@${BOT_USERNAME}`, 'ig'), '').trim();
    }

    // ⚡ TELEGRAM DEEP-LINK PAYLOAD ⚡
    // The app's "Open Telegram" button links to t.me/<bot>?start=<code>. On first contact,
    // Telegram sends that as a literal "/start <code>" message, not the bare code — unwrap
    // it here so the link-code check in /api/deai/core (which expects just the code) sees
    // ABA-XXXXXX instead of "/start ABA-XXXXXX". A bare "/start" (no payload, e.g. the user
    // just opened the bot without a link code) passes through unchanged.
    const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
    if (startMatch?.[1]) {
      text = startMatch[1].trim();
    }

    // 🔒 DELETE THE PIN FROM CHAT HISTORY IMMEDIATELY.
    //
    // 🔴 The old check was /^\d{4}$/ — EXACTLY four digits. But PINs are 4-6 digits, so a
    // 5- or 6-digit PIN was NEVER deleted and sat in the chat forever. Anyone who later got
    // access to the phone or the Telegram session could read it and transact.
    if (/^\d{4,6}$/.test(text.trim())) {
      await fetch(`https://api.telegram.org/bot${DEAI_BOT_TOKEN}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      });
    }

    // Forward to the Universal Core Engine — platform_id is the SENDER's own id (see the
    // fix above), and chat_type lets the core engine refuse to bind a wallet-link code
    // inside a group (typing a one-time code where the whole group can see it is a real
    // leak risk — linking should only ever happen in a private DM).
    const response = await fetch(CORE_ENGINE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalAuthHeaders() },
      body: JSON.stringify({
        platform: 'TELEGRAM',
        platform_id: senderId,
        text: text,
        chat_type: chatType || 'private',
      })
    });

    const engineData = await response.json();
    const isGroupMessage = !!chatType && chatType !== 'private';

    // Execute the Brain's instructions
    if (engineData.action === 'REPLY' || engineData.action === 'SUCCESS_RECEIPT' || engineData.action === 'REQUIRE_TOKEN_SELECTION') {
      if (isGroupMessage) {
        // ⚡ NEVER post balances, tx hashes, or payment confirmations into a shared group —
        // DM the actual sender privately instead. This only works if Telegram has seen them
        // message the bot privately at least once before (a platform restriction, not
        // something we can bypass) — if it fails, tell them so in the group without leaking
        // the sensitive content there.
        const dmRes = await fetch(`https://api.telegram.org/bot${DEAI_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: senderId, text: engineData.message, parse_mode: 'Markdown' }),
        });
        const dmData = await dmRes.json();
        await fetch(`https://api.telegram.org/bot${DEAI_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            reply_to_message_id: messageId,
            text: dmData.ok ? "✅ Sent you the details in a DM." : `⚠️ I need to DM you privately for this — please start a chat with me first: https://t.me/${BOT_USERNAME}`,
          }),
        });
      } else {
        await fetch(`https://api.telegram.org/bot${DEAI_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: engineData.message,
              parse_mode: 'Markdown'
            })
        });
      }
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Telegram Webhook Error:", error);
    return NextResponse.json({ success: false });
  }
}
