import crypto from 'crypto';

// 🔐 VTPASS REQUEST ID — the lookup key for a transaction's `purchased_code` (the electricity
// meter token / WAEC-JAMB PIN the customer paid for). Those are BEARER SECRETS: whoever holds
// the code can redeem the value. It is also the key for the public shareable receipt page
// (src/app/receipt/[requestId]/page.tsx), which renders the customer's verified name and
// address. So this identifier MUST NOT be predictable.
//
// 🔴 THE ORIGINAL BUG (Audit v2, H-1):
//     const dateStr      = YYYYMMDDHHmm;                                // fully predictable
//     const randomSuffix = Math.random().toString(36).substring(2, 10); // NOT a CSPRNG
// V8's xorshift128+ state is recoverable from a handful of observed outputs, so future ids
// were derivable. Combined with (at the time) no auth and no rate limit on /api/requery, that
// put another customer's token within guessing range.
//
// 🔴 WHY THIS FILE EXISTS: the fixed generator was then implemented TWICE — `getStrictRequestId`
// in src/lib/vend.ts and `generateRequestId` in src/lib/vtpass.js — two copies of one
// security-critical primitive, which is exactly how one copy silently rots. `vend.ts` couldn't
// simply import from `vtpass.js` (it already imports getHeaders from there, so re-exporting the
// other way would be circular), hence a third, dependency-free module both can point at. It
// deliberately imports nothing but `crypto`, so tests can exercise the REAL shipped function
// instead of re-implementing it locally.
//
// FORMAT: VTpass mandates the first 12 characters be YYYYMMDDHHmm in Africa/Lagos, followed by
// alphanumerics. We append 12 CSPRNG characters over a 36-char alphabet — 36^12 ≈ 4.7e18,
// which is not brute-forceable.

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Cryptographically random suffix. `crypto.randomInt` performs rejection sampling, so it is
 * UNBIASED — unlike `randomBytes(n)[i] % 36`, which skews toward the first four characters
 * because 256 % 36 !== 0.
 */
export function randomIdSuffix(length = 12): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += ID_ALPHABET[crypto.randomInt(0, ID_ALPHABET.length)];
  }
  return s;
}

/** VTpass-compliant, unguessable request id: YYYYMMDDHHmm (Africa/Lagos) + 12 random chars. */
export function getStrictRequestId(): string {
  const date = new Date();
  const lagosTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);

  const [datePart, timePart] = lagosTime.split(', ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute] = timePart.split(':');
  const safeHour = hour === '24' ? '00' : hour;

  return `${year}${month}${day}${safeHour}${minute}${randomIdSuffix(12)}`;
}
