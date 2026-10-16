import { describe, it, expect, vi, beforeAll } from 'vitest';
import crypto from 'crypto';

// ⚡ THE WHATSAPP FLOWS DATA ENDPOINT (src/app/api/whatsapp/flow + src/lib/whatsappFlowCrypto.ts).
// Requests are encrypted exactly as WhatsApp does it here (RSA-OAEP-SHA256 key wrap, AES-128-GCM
// payload), so a passing test means the real handshake works: signature first (432), a key
// mismatch is 421, and the answer decrypts with the flipped IV.

vi.mock('server-only', () => ({}));
const handleCheckoutRequest = vi.fn(async (req: { action?: string }) => (req.action === 'ping' ? { data: { status: 'active' } } : { screen: 'SERVICE', data: {} }));
vi.mock('@/lib/whatsappCheckout', () => ({ handleCheckoutRequest: (r: { action?: string }) => handleCheckoutRequest(r) }));

const SECRET = 'app-secret';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

beforeAll(() => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_FLOW_PRIVATE_KEY = privateKey;
});

const { POST } = await import('@/app/api/whatsapp/flow/route');

/** What WhatsApp sends: a fresh AES key wrapped to our public key, the payload AES-GCM'd. */
function encryptAsWhatsApp(payload: unknown, pub = publicKey) {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return {
    aesKey, iv,
    body: {
      encrypted_flow_data: data.toString('base64'),
      encrypted_aes_key: crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64'),
      initial_vector: iv.toString('base64'),
    },
  };
}
function decryptAnswer(b64: string, aesKey: Buffer, iv: Buffer) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-128-gcm', aesKey, Buffer.from(iv.map((b) => ~b & 0xff)));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
}
const call = (body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return POST(new Request('https://www.abapays.com/api/whatsapp/flow', { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: raw }));
};

describe('/api/whatsapp/flow', () => {
  it('answers the health-check ping, encrypted with the flipped IV', async () => {
    const { body, aesKey, iv } = encryptAsWhatsApp({ version: '3.0', action: 'ping' });
    const res = await call(body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(decryptAnswer(await res.text(), aesKey, iv)).toEqual({ data: { status: 'active' } });
  });

  it('refuses a request not signed with our app secret (432), before decrypting anything', async () => {
    handleCheckoutRequest.mockClear();
    const { body } = encryptAsWhatsApp({ action: 'ping' });
    expect((await call(body, 'wrong-secret')).status).toBe(432);
    expect(handleCheckoutRequest).not.toHaveBeenCalled();
  });

  it('answers 421 when the request was encrypted to a different key, so WhatsApp re-fetches ours', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const { body } = encryptAsWhatsApp({ action: 'ping' }, other.publicKey);
    expect((await call(body)).status).toBe(421);
  });
});
