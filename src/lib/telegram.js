import 'server-only';

/**
 * sendTelegramAlert
 * Sends a high-priority message to the Admin's Telegram
 */
// ⚡ REMOVED TypeScript type (: string)
export const sendTelegramAlert = async (message) => {
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
