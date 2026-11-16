// Whether an email address could be a real, reachable one. Pure: shared by the support form (instant
// feedback) and /api/support (which also checks the domain's mail servers — src/lib/emailDomain.ts).
//
// 2026-11-15: "probe" support tickets came in from `i147@example.com` and friends. Those pass a
// simple x@y.z shape check, but example.com and the other names below are reserved by the internet's
// own standards (RFC 2606 / RFC 6761) and can never receive mail.

const SHAPE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Second-level names reserved for documentation (RFC 2606). */
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
/** Top-level names reserved for tests, documentation and invalid use (RFC 2606 / 6761). */
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost', 'local']);

export type EmailProblem = 'EMPTY' | 'BAD_FORMAT' | 'RESERVED_DOMAIN';

/** null when the address is plausible; otherwise why it isn't. */
export function emailProblem(raw: string | null | undefined): EmailProblem | null {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) return 'EMPTY';
  if (email.length > 254 || !SHAPE.test(email)) return 'BAD_FORMAT';
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (RESERVED_DOMAINS.has(domain) || [...RESERVED_DOMAINS].some((d) => domain.endsWith(`.${d}`)) || RESERVED_TLDS.has(tld)) return 'RESERVED_DOMAIN';
  return null;
}

/** The domain part, lower-cased. */
export const emailDomain = (raw: string) => String(raw).trim().toLowerCase().split('@').pop() || '';
