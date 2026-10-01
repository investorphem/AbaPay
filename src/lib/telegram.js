import 'server-only';

// ⏱ DE-DUPLICATION (M5). The same failure repeating (a provider down, a cron retrying every
// minute) used to send the same alert every time, which trains whoever reads the channel to
// mute it. An alert is held back if the same `key` (or, without one, the same text) was sent
// in the last 15 minutes on this instance. The count of suppressed repeats rides on the next
// one that goes out, so nothing is silently lost. Per-instance on purpose: a cross-instance
// store would need a table for what is a noise filter, not a correctness guarantee.
const DEDUPE_MS = 15 * 60 * 1000;
const recent = new Map(); // key -> { at, suppressed }

function dedupeKey(message, key) {
  return key ? `k:${key}` : `t:${String(message).slice(0, 500)}`;
}

/** @internal for tests */
export const _resetTelegramDedupe = () => recent.clear();

/**
 * sendTelegramAlert
 * Sends a high-priority message to the Admin's Telegram.
 *
 * @param {string} message
 * @param {{ key?: string }} [opts] key = what makes two alerts "the same", e.g.
 *   `vtpass-float-low`. Defaults to the message text.
 */
export const sendTelegramAlert = async (message, opts = {}) => {
  const k = dedupeKey(message, opts.key);
  const now = Date.now();
  const prev = recent.get(k);
  if (prev && now - prev.at < DEDUPE_MS) {
    prev.suppressed += 1;
    return { ok: true, suppressed: true };
  }
  const repeats = prev && prev.suppressed > 0 ? prev.suppressed : 0;
  recent.set(k, { at: now, suppressed: 0 });
  if (recent.size > 500) recent.delete(recent.keys().next().value);
  if (repeats) message = `${message}\n\n_(${repeats} identical alert${repeats === 1 ? '' : 's'} suppressed in the last 15 min)_`;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.error("⚠️ Telegram Config Missing in Vercel/env");
    return null;
  }

  // ⚡ SMART LABELING: Instantly know if an alert is real or just a test ⚡
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
  const finalMessage = appMode === "live" ? message : `🛠️ *[SANDBOX TEST]*\n${message}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: finalMessage,
        parse_mode: 'Markdown'
      })
    });

    return await res.json();
  } catch (error) {
    console.error("Telegram API Error:", error);
    return null;
  }
};
/**
 * ⚡ Send a message to a SPECIFIC user's chat (not the admin channel).
 *
 * sendTelegramAlert() above always targets TELEGRAM_ADMIN_CHAT_ID — it's for operator
 * alerts. Using it for user-facing notifications would send every user's bill reminder to
 * the admin instead of to the user. This function is for messaging real users.
 *
 * Uses the DeAI bot token so replies land back in the DeAI conversation.
 */
export const sendTelegramToUser = async (chatId, message) => {
  const token = process.env.DEAI_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !chatId) {
    console.error("⚠️ sendTelegramToUser: missing bot token or chat id");
    return null;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("Telegram user message failed:", err);
    return null;
  }
};
