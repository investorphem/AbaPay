// ⚡ Send a free-form text message to a WhatsApp user via Meta's Graph API — the same call
// the inbound webhook uses to reply. Used by the autonomous scheduler to report a scheduled
// payment's outcome back to a user who set it up from WhatsApp.
//
// ⚠️ WhatsApp's 24-hour customer-service window: a business can only free-form message a user
// within 24h of THEIR last message. A scheduled payment minutes/hours later is normally still
// inside that window (the user just chatted to set it up), but a long-dated schedule may fall
// outside it, in which case Meta rejects the send. We log and move on rather than throw —
// the receipt is always in History regardless.
export async function sendWhatsAppMessage(toNumber: string, message: string): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId || !toNumber) {
    console.error('[WhatsApp] sendWhatsAppMessage: missing token, phone id, or recipient.');
    return false;
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: message } }),
    });
    if (!res.ok) {
      console.error('[WhatsApp] sendWhatsAppMessage failed:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[WhatsApp] sendWhatsAppMessage error:', err);
    return false;
  }
}

export async function sendWhatsAppOTP(phone: string, otpCode: string): Promise<boolean> {
    try {
        // 🚨 PLACEHOLDER FOR FUTURE META/TWILIO API 🚨
        console.log(`\n========================================`);
        console.log(`📲 MOCK WHATSAPP SENT TO: ${phone}`);
        console.log(`🔢 YOUR ABAPAY VERIFICATION CODE: ${otpCode}`);
        console.log(`========================================\n`);

        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 800));
        return true; 
    } catch (error) {
        console.error("Failed to send WhatsApp OTP:", error);
        return false;
    }
}