import { describe, it, expect, afterEach } from 'vitest';
import { PIN_FLOW_JSON, PIN_FLOW_TOKEN_PREFIX, isFlowReply, pinFlowId, pinFlowMessage, pinFromFlowReply } from '@/lib/whatsappPinFlow';

// ⚡ SECURE PIN ENTRY ON WHATSAPP (src/lib/whatsappPinFlow.ts). The PIN must be masked in the
// form and in WhatsApp's response summary, and only a well-formed reply to OUR Flow may be read
// as a PIN.

const reply = (data: unknown) => ({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify(data) } } });

afterEach(() => { delete process.env.WHATSAPP_PIN_FLOW_ID; delete process.env.WHATSAPP_PIN_FLOW_MODE; });

describe('the Flow definition', () => {
  it('masks the PIN on screen and in the response summary', () => {
    const screen = PIN_FLOW_JSON.screens[0];
    expect(screen.sensitive).toContain('pin');
    const input = (screen.layout.children[0].children as { type: string; [k: string]: unknown }[]).find((c) => c.type === 'TextInput');
    expect(input).toMatchObject({ name: 'pin', 'input-type': 'passcode', 'min-chars': 4, 'max-chars': 6 });
  });
});

describe('pinFromFlowReply', () => {
  it('reads a 4–6 digit PIN from our Flow', () => {
    expect(pinFromFlowReply(reply({ flow_token: `${PIN_FLOW_TOKEN_PREFIX}abc`, pin: '4821' }))).toBe('4821');
    expect(pinFromFlowReply(reply({ flow_token: `${PIN_FLOW_TOKEN_PREFIX}abc`, pin: ' 123456 ' }))).toBe('123456');
  });

  it('ignores another Flow’s reply, a malformed PIN, plain text and broken JSON', () => {
    expect(pinFromFlowReply(reply({ flow_token: 'someone-else:1', pin: '4821' }))).toBeNull();
    expect(pinFromFlowReply(reply({ flow_token: `${PIN_FLOW_TOKEN_PREFIX}abc`, pin: '12' }))).toBeNull();
    expect(pinFromFlowReply(reply({ flow_token: `${PIN_FLOW_TOKEN_PREFIX}abc`, pin: '12ab' }))).toBeNull();
    expect(pinFromFlowReply({ type: 'text' })).toBeNull();
    expect(pinFromFlowReply({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{oops' } } })).toBeNull();
  });

  it('isFlowReply recognises any Flow completion', () => {
    expect(isFlowReply(reply({}))).toBe(true);
    expect(isFlowReply({ type: 'text' })).toBe(false);
  });
});

describe('pinFlowMessage / pinFlowId', () => {
  it('is off until a numeric Flow id is configured', () => {
    expect(pinFlowId()).toBeNull();
    process.env.WHATSAPP_PIN_FLOW_ID = 'not-a-number';
    expect(pinFlowId()).toBeNull();
    process.env.WHATSAPP_PIN_FLOW_ID = '1234567890';
    expect(pinFlowId()).toBe('1234567890');
  });

  it('builds an "Enter PIN" Flow button carrying our token and the engine’s text', () => {
    const m = pinFlowMessage('2348012345678', 'Confirm MTN data for 0806… (₦100).', '1234567890', 'n1');
    expect(m).toMatchObject({ to: '2348012345678', type: 'interactive', interactive: { type: 'flow', body: { text: 'Confirm MTN data for 0806… (₦100).' } } });
    expect(m.interactive.action.parameters).toMatchObject({ flow_id: '1234567890', flow_cta: 'Enter PIN', flow_token: `${PIN_FLOW_TOKEN_PREFIX}n1`, flow_action_payload: { screen: 'PIN' } });
    expect(m.interactive.action.parameters).not.toHaveProperty('mode');
  });

  it('marks the message as draft only when asked, and caps the body at 1024 characters', () => {
    process.env.WHATSAPP_PIN_FLOW_MODE = 'draft';
    const m = pinFlowMessage('1', 'x'.repeat(2000), '1', 'n');
    expect(m.interactive.action.parameters).toMatchObject({ mode: 'draft' });
    expect(m.interactive.body.text).toHaveLength(1024);
  });
});
