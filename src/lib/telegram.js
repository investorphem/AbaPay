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
