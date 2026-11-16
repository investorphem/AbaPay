import 'server-only';
import { promises as dns } from 'dns';

// Whether a domain can receive email: it publishes mail servers (MX), or — the fallback mail
// delivery itself uses (RFC 5321 §5.1) — an address record. A made-up domain has neither.
//
// Fails OPEN on a DNS outage or timeout ('unknown'): a real customer must never be blocked from
// support because the resolver hiccuped. Only a definite "this domain does not exist / has no mail
// servers" refuses.

const TIMEOUT_MS = 3000;
const cache = new Map<string, { verdict: 'yes' | 'no'; at: number }>();
const CACHE_MS = 60 * 60 * 1000;

const withTimeout = <T>(p: Promise<T>) => Promise.race([
  p, new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), TIMEOUT_MS)),
]);

/** A definite "nothing here" from DNS — anything else is a resolver problem, not an answer. */
const isNoRecord = (e: unknown) => ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(String((e as { code?: string })?.code));

export async function domainReceivesMail(domain: string): Promise<'yes' | 'no' | 'unknown'> {
  const d = domain.trim().toLowerCase();
  const hit = cache.get(d);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.verdict;

  let verdict: 'yes' | 'no' | 'unknown';
  try {
    const mx = await withTimeout(dns.resolveMx(d));
    // A "null MX" (RFC 7505: one record pointing at ".") explicitly says the domain takes no mail.
    verdict = mx.some((r) => r.exchange && r.exchange !== '.') ? 'yes' : 'no';
  } catch (e) {
    if (!isNoRecord(e)) return 'unknown';
    try {
      const a = await withTimeout(dns.resolve(d));
      verdict = a.length ? 'yes' : 'no';
    } catch (e2) {
      if (!isNoRecord(e2)) return 'unknown';
      verdict = 'no';
    }
  }
  cache.set(d, { verdict, at: Date.now() });
  return verdict;
}
