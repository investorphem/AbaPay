// What a VTpass response code means, and what an operator should check — for the admin's Telegram
// alert and the order's stored error. VTpass doesn't always send `response_description` (087 came
// back without one on 2026-11-18, and the alert read "Code 087 - undefined").
//
// Meanings from VTpass's response-code reference; the hints are AbaPay's own.

const CODES: Record<string, { meaning: string; hint?: string }> = {
  '011': { meaning: 'INVALID ARGUMENTS', hint: 'A field VTpass needs is missing or malformed (number, plan, amount).' },
  '012': { meaning: 'PRODUCT DOES NOT EXIST', hint: 'The service or plan code is not in the VTpass catalogue.' },
  '013': { meaning: 'BELOW MINIMUM AMOUNT ALLOWED' },
  '014': { meaning: 'REQUEST ID ALREADY EXIST', hint: 'This request id was used before; nothing new was sent.' },
  '015': { meaning: 'INVALID REQUEST ID', hint: 'VTpass has no record of this request id.' },
  '016': { meaning: 'TRANSACTION FAILED', hint: 'Often the number is on a different network than the product (or ported), or the biller refused it.' },
  '017': { meaning: 'ABOVE MAXIMUM AMOUNT ALLOWED' },
  '018': { meaning: 'LOW WALLET BALANCE', hint: 'Top up the VTpass wallet; every order fails until then.' },
  '019': { meaning: 'LIKELY DUPLICATE TRANSACTION', hint: 'Same product, number and amount within a short window.' },
  '021': { meaning: 'ACCOUNT LOCKED', hint: 'The VTpass account is locked; contact VTpass.' },
  '022': { meaning: 'ACCOUNT SUSPENDED', hint: 'The VTpass account is suspended; contact VTpass.' },
  '023': { meaning: 'API ACCESS NOT ENABLED FOR USER', hint: 'Enable API access on the VTpass account.' },
  '024': { meaning: 'ACCOUNT INACTIVE', hint: 'The VTpass account is inactive; contact VTpass.' },
  '027': { meaning: 'IP NOT WHITELISTED', hint: 'The server IP is not whitelisted on the VTpass account.' },
  '028': { meaning: 'PRODUCT IS NOT WHITELISTED ON YOUR ACCOUNT', hint: 'Enable this product on the VTpass account.' },
  '030': { meaning: 'BILLER NOT REACHABLE AT THIS POINT', hint: 'The biller is down; retry later.' },
  '034': { meaning: 'SERVICE SUSPENDED', hint: 'VTpass suspended this service.' },
  '035': { meaning: 'SERVICE INACTIVE', hint: 'VTpass has this service switched off.' },
  '040': { meaning: 'TRANSACTION REVERSAL', hint: 'VTpass reversed it; the order was not delivered.' },
  '083': { meaning: 'SYSTEM ERROR', hint: 'A VTpass-side error; contact VTpass support if it repeats.' },
  '085': { meaning: 'IMPROPER REQUEST ID', hint: 'The request id must start with today’s date (Africa/Lagos).' },
  '087': { meaning: 'INVALID CREDENTIALS', hint: 'The VTPASS_API_KEY / PUBLIC_KEY / SECRET_KEY on this server don’t match VTpass (e.g. rotated keys not redeployed).' },
  '089': { meaning: 'REQUEST IS PROCESSING', hint: 'VTpass is still working on the previous request.' },
  '091': { meaning: 'TRANSACTION NOT PROCESSED' },
  '099': { meaning: 'TRANSACTION IS PROCESSING' },
};

/** "INVALID CREDENTIALS" — VTpass's own description when it sent one, else the known meaning. */
export function vtpassDescription(code: unknown, description?: unknown): string {
  const given = String(description ?? '').trim();
  if (given && given !== 'undefined' && given !== 'null') return given;
  return CODES[String(code ?? '')]?.meaning || 'no description from VTpass';
}

/** The admin line: "087 INVALID CREDENTIALS — The VTPASS_API_KEY … don't match VTpass …". */
export function vtpassAdminError(code: unknown, description?: unknown): string {
  const hint = CODES[String(code ?? '')]?.hint;
  return `${String(code ?? '?')} ${vtpassDescription(code, description)}${hint ? ` — ${hint}` : ''}`;
}
