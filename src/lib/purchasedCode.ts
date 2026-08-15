// ⚡ WHAT COUNTS AS A REAL TOKEN / PIN
//
// 🔴 THE BUG THIS FIXES: VTpass does not omit the token when it hasn't issued one — it returns
// the PLACEHOLDER STRING `"Token : N/A"` in `purchased_code`. Every vend path took that at face
// value (`payData.purchased_code || …`) and stored it verbatim, so the database ended up holding
// "Token : N/A" as though it were a meter token. Downstream, the receipt email prefixed its own
// label and rendered:
//
//     Token / PIN        Token : Token : N/A
//
// …which reads as a delivered token that is literally "N/A". The receipt modal already stripped
// the redundant prefix for display (Modals.tsx), but that only hid half of it, and only in one
// of the four surfaces.
//
// Normalising at the point of STORAGE is what actually fixes it: a placeholder becomes null, so
// `hasPin` is correctly false, the email falls back to the Reference ID row, and the SMS stops
// telling the customer their token is "N/A".

/** Placeholder values VTpass uses to mean "no token/PIN issued". Compared case-insensitively. */
const PLACEHOLDERS = new Set(['', 'n/a', 'na', 'nil', 'null', 'none', 'undefined', 'vended successfully']);

/**
 * Reduce a VTpass `purchased_code` to the actual token/PIN, or null when there isn't one.
 *
 * Strips any leading "Token:" / "PIN:" / "Token -" label VTpass bakes into the value, then
 * rejects the placeholders above. Returns null rather than an empty string so every caller's
 * existing `if (code)` truthiness check does the right thing with no further changes.
 */
/**
 * Will this purchase ever produce a token/PIN at all?
 *
 * 🔴 POSTPAID ELECTRICITY NEVER ISSUES A TOKEN. Only a prepaid meter gets one — postpaid is a
 * billed account, so the payment settles against the bill and there is nothing to key in. That
 * is precisely why VTpass answers a postpaid vend with the "Token : N/A" placeholder rather
 * than a code.
 *
 * This distinction is load-bearing, not cosmetic. Both /api/requery and reconcileStuck refuse
 * to mark an electricity transaction SUCCESS until a token exists ("Provider is still
 * generating the Token/PIN"). That gate only ever passed for postpaid because the placeholder
 * string happened to be truthy — so the moment placeholders are correctly normalised to null,
 * an unqualified gate would hold every postpaid payment at PENDING forever, waiting on a token
 * the provider is never going to send. Hence: the gate must ask THIS, not just the category.
 *
 * An unknown/absent variation is treated as prepaid — the conservative direction, since it
 * holds the transaction for review rather than completing it without a token the customer needs.
 */
export function issuesTokenOrPin(
  serviceCategory: string | null | undefined,
  variationCode: string | null | undefined,
): boolean {
  const category = String(serviceCategory || '').toUpperCase();
  if (category === 'EDUCATION') return true;
  if (category !== 'ELECTRICITY') return false;
  return String(variationCode || '').trim().toLowerCase() !== 'postpaid';
}

export function normalizePurchasedCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  const stripped = String(raw)
    .replace(/^\s*(?:token|pin|code)\s*[:\-]\s*/i, '')
    .trim();

  if (PLACEHOLDERS.has(stripped.toLowerCase())) return null;
  return stripped;
}
