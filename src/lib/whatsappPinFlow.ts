// ⚡ SECURE PIN ENTRY ON WHATSAPP — a WhatsApp Flow instead of a chat message.
//
// WhatsApp's Cloud API can never delete a message a customer sent (see the webhook), so a PIN
// typed into the chat stayed in the user's history for good; all the bot could do was ask them
// to delete it. A Flow fixes that at the source: when the engine is waiting for a PIN, the bot
// sends an "Enter PIN" button that opens a native WhatsApp form with a masked passcode field.
// The PIN never appears as a chat bubble, and because the screen marks `pin` as `sensitive`,
// WhatsApp masks it in the "View response" summary too.
//
// No endpoint is involved (the form completes locally and WhatsApp delivers the answer to our
// webhook as an `nfm_reply` message), so there is nothing extra to host and no extra cost: it is
// an ordinary interactive reply inside the customer-service window.
//
// Turned on by WHATSAPP_PIN_FLOW_ID (the published Flow's id; `scripts/whatsapp-pin-flow.mjs`
// creates and publishes it). Without it the bot falls back to asking for the PIN as text.

/** The Flow definition published to Meta (src/config/whatsapp-pin-flow.json, also read by scripts/whatsapp-pin-flow.mjs). `pin` is masked on screen and in the response summary. */
export { default as PIN_FLOW_JSON } from '@/config/whatsapp-pin-flow.json';

/** Prefix on the flow_token, so a reply can be told apart from any other Flow the number might use. */
export const PIN_FLOW_TOKEN_PREFIX = 'abapay-pin:';

export function pinFlowId(): string | null {
  const id = process.env.WHATSAPP_PIN_FLOW_ID;
  return id && /^\d+$/.test(id) ? id : null;
}

/** The interactive message: the engine's text (what is being paid) plus an "Enter PIN" button that opens the Flow. */
export function pinFlowMessage(to: string, bodyText: string, flowId: string, nonce: string) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: 'Enter your PIN' },
      // Meta caps an interactive body at 1024 characters.
      body: { text: bodyText.slice(0, 1024) },
      footer: { text: 'AbaPay Secure' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: `${PIN_FLOW_TOKEN_PREFIX}${nonce}`,
          flow_id: flowId,
          flow_cta: 'Enter PIN',
          flow_action: 'navigate',
          flow_action_payload: { screen: 'PIN' },
          // A draft Flow can be tested by the account's own numbers before it is published.
          ...(process.env.WHATSAPP_PIN_FLOW_MODE === 'draft' ? { mode: 'draft' } : {}),
        },
      },
    },
  };
}

type IncomingMessage = { type?: string; interactive?: { type?: string; nfm_reply?: { response_json?: string } } };

/**
 * The PIN from a completed PIN Flow, or null if this message isn't one. Only digits, 4 to 6 of
 * them, from a reply carrying our flow_token prefix.
 */
export function pinFromFlowReply(message: IncomingMessage): string | null {
  if (message?.type !== 'interactive' || message.interactive?.type !== 'nfm_reply') return null;
  try {
    const data = JSON.parse(message.interactive.nfm_reply?.response_json || '{}');
    if (typeof data.flow_token !== 'string' || !data.flow_token.startsWith(PIN_FLOW_TOKEN_PREFIX)) return null;
    const pin = String(data.pin ?? '').trim();
    return /^\d{4,6}$/.test(pin) ? pin : null;
  } catch {
    return null;
  }
}

/** Is this an `nfm_reply` (any Flow completion)? Used to answer a malformed PIN reply instead of ignoring it. */
export function isFlowReply(message: IncomingMessage): boolean {
  return message?.type === 'interactive' && message.interactive?.type === 'nfm_reply';
}
