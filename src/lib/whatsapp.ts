// ⚡ Outbound WhatsApp sends via Meta's Graph API — the same call the inbound webhook uses to
// reply, plus the template fallback that makes an OUT-OF-WINDOW send possible at all.
//
// 🔴 THE 24-HOUR CUSTOMER SERVICE WINDOW. A business may only send FREE-FORM text to a user
// within 24 hours of THAT USER's last message. Outside it, Meta rejects the send outright —
// error 131047, "re-engagement message" — and the ONLY thing that gets through is a
// pre-approved template.
//
// This is not a volume limit and Business Verification does not lift it. Verification raises
// how MANY unique people you may message outside a window; it has no bearing on WHAT you may
// send them. The two are independent, and conflating them is why this looked like it should
// already work.
//
// The scheduler is the one caller this bites (src/lib/scheduler.ts): a payment scheduled for
// tomorrow runs long after the chat that created it went quiet, so its outcome report — the
// message telling someone their electricity bill did or didn't get paid — was being rejected
// every time. It failed quietly, too: the result was logged and swallowed, so the only symptom
// was a user who never heard back and had to find the receipt in History themselves.
//
// So: try text (free, and correct while the window is open), and on a 131047 specifically,
// resend the same content through a utility template. Any other failure is a real failure and
// is not retried — re-sending a message Meta rejected for being spam-like, or for a number
// that doesn't exist, would earn a quality-rating hit for nothing.

/** Meta's "more than 24h since the user last replied" rejection. 470 is the pre-v16 spelling. */
const OUT_OF_WINDOW_CODES = new Set([131047, 470]);

/** Meta caps a single body parameter at 1024 characters. */
const TEMPLATE_PARAM_MAX = 1024;

const GRAPH_VERSION = 'v18.0';

function graphCredentials() {
  return {
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

/**
 * Did Meta reject this because the 24-hour window has closed, as opposed to anything else?
 *
 * The code lives at `error.code`, and Meta also mirrors some of them into
 * `error.error_data.details` as prose. Only the numeric code is trusted — matching on the
 * message text would misfire the moment Meta rewords it.
 */
export function isOutOfWindowError(body: string): boolean {
  try {
    const code = JSON.parse(body)?.error?.code;
    return OUT_OF_WINDOW_CODES.has(Number(code));
  } catch {
    return false;
  }
}

/**
 * Squeeze a chat message into something Meta will accept as a template parameter.
 *
 * 🔴 A BODY PARAMETER MAY NOT CONTAIN NEWLINES, TABS, OR MORE THAN 4 CONSECUTIVE SPACES.
 * Meta rejects the whole send if it does — and every message the scheduler produces is
 * multi-line, so passing one through untouched would swap a rejection for a rejection.
 *
 * Paragraph breaks become " — " so the message still reads as separate thoughts rather than
 * one run-on line; single breaks become spaces. The template itself supplies the line
 * structure around this.
 */
export function toTemplateParameter(message: string): string {
  const flattened = String(message ?? '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, ' — ')   // paragraph break → visible separator
    .replace(/\n/g, ' ')          // single break → space
    .replace(/\t/g, ' ')
    .replace(/ {4,}/g, '   ')     // 4+ spaces is a rejection; 3 is the most that's safe
    .trim();

  return flattened.length > TEMPLATE_PARAM_MAX
    ? `${flattened.slice(0, TEMPLATE_PARAM_MAX - 1)}…`
    : flattened;
}

async function postToGraph(payload: Record<string, unknown>): Promise<{ ok: boolean; body: string }> {
  const { token, phoneId } = graphCredentials();
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, body: res.ok ? '' : await res.text() };
}

/**
 * Send a message to a WhatsApp user, falling back to the configured utility template when the
 * 24-hour window has closed.
 *
 * Returns true only if the user actually received something. A false here is what the caller
 * should treat as "they were not told" — the receipt still lands in History regardless, which
 * is why no caller throws on it.
 */
export async function sendWhatsAppMessage(toNumber: string, message: string): Promise<boolean> {
  const { token, phoneId } = graphCredentials();
  if (!token || !phoneId || !toNumber) {
    console.error('[WhatsApp] sendWhatsAppMessage: missing token, phone id, or recipient.');
    return false;
  }

  try {
    const text = await postToGraph({
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: message },
    });
    if (text.ok) return true;

    if (!isOutOfWindowError(text.body)) {
      // A real failure — expired token, bad phone id, blocked recipient. Not retryable, and
      // re-sending would only cost quality rating.
      console.error('[WhatsApp] sendWhatsAppMessage failed:', text.body);
      return false;
    }

    // ── The window has closed. Only a template can reach them now. ──
    const templateName = process.env.WHATSAPP_SCHEDULE_TEMPLATE_NAME;
    if (!templateName) {
      console.error(
        '[WhatsApp] 24h window closed and WHATSAPP_SCHEDULE_TEMPLATE_NAME is not set — the user was NOT notified. ' +
        'Create an approved utility template and set that variable; see README (WhatsApp Cloud API).',
      );
      return false;
    }

    const template = await postToGraph({
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: templateName,
        language: { code: process.env.WHATSAPP_SCHEDULE_TEMPLATE_LANG || 'en' },
        components: [{
          type: 'body',
          parameters: [{ type: 'text', text: toTemplateParameter(message) }],
        }],
      },
    });

    if (!template.ok) {
      // Almost always one of: the template name doesn't exist, it isn't APPROVED yet, its
      // language code doesn't match, or its body doesn't declare exactly one {{1}}.
      console.error(`[WhatsApp] Template fallback "${templateName}" was rejected:`, template.body);
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
