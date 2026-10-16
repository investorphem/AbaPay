import 'server-only';
import crypto from 'crypto';

// ⚡ WHATSAPP FLOWS DATA-ENDPOINT ENCRYPTION — Meta's scheme, nothing of our own.
//
// Every request to a Flow's data endpoint is encrypted by WhatsApp:
//   • encrypted_aes_key — a fresh 128-bit AES key, RSA-OAEP (SHA-256) encrypted to OUR public
//     key (uploaded once to the WhatsApp Business Account);
//   • encrypted_flow_data — the JSON request, AES-128-GCM with that key and `initial_vector`,
//     the 16-byte auth tag appended;
//   • the response must be AES-128-GCM with the SAME key and the IV with every bit flipped,
//     tag appended, returned base64 as plain text.
// A request we can't decrypt is answered 421, which tells WhatsApp to re-fetch our public key.

export type EncryptedFlowRequest = { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string };

export class FlowDecryptError extends Error {}

export function decryptFlowRequest(body: EncryptedFlowRequest, privateKeyPem: string, passphrase?: string) {
  let aesKey: Buffer;
  try {
    aesKey = crypto.privateDecrypt(
      { key: crypto.createPrivateKey({ key: privateKeyPem, passphrase }), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(body.encrypted_aes_key, 'base64'),
    );
  } catch {
    throw new FlowDecryptError('Could not decrypt the AES key with our private key.');
  }
  const iv = Buffer.from(body.initial_vector, 'base64');
  const data = Buffer.from(body.encrypted_flow_data, 'base64');
  const TAG = 16;
  try {
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
    decipher.setAuthTag(data.subarray(data.length - TAG));
    const json = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG)), decipher.final()]).toString('utf8');
    return { request: JSON.parse(json) as Record<string, unknown>, aesKey, iv };
  } catch {
    throw new FlowDecryptError('Could not decrypt the Flow payload.');
  }
}

export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
