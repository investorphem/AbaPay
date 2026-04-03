// src/lib/messaging.js
import 'server-only';

export const sendAbaPaySms = async (recipient, message) => {
  const url = "https://messaging.vtpass.com/v2/api/sms/dnd-fallback";
  
  const body = new URLSearchParams({
    sender: 'AbaPay',
    recipient: recipient,
    message: message,
    responsetype: 'json'
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Token': process.env.VTPASS_MSG_TOKEN,
        'X-Secret': process.env.VTPASS_MSG_SECRET,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    return await res.json();
  } catch (error) {
    console.error("SMS Failed:", error);
    return null;
  }
};