import 'server-only';

/**
 * sendTelegramAlert
 * Sends a high-priority message to the Admin's Telegram
 */
export const sendTelegramAlert = async (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.error("⚠️ Telegram Config Missing in .env.local");
    return null;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    
    return await res.json();
  } catch (error) {
    console.error("Telegram API Error:", error);
    return null;
  }
};