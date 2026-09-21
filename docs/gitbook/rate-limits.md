# Rate limits

{% hint style="info" %}
**Defense in depth, not the real backstop.** Rate limiting slows down abuse of a leaked
credential before its owner sees the out-of-band alert and revokes it. The actual backstop is
the on-chain allowance — same as everywhere else in this handbook — plus the [kill
switches](kill-switches.md) and PIN lockout.
{% endhint %}

Two independent layers apply to every agent-facing call:

* **Per-IP, at the route.** A fixed window keyed by client IP, applied per endpoint. The IP is
  read in order of trust — a platform-set header first, then the rightmost entry of
  `X-Forwarded-For` (never the leftmost, which a caller can forge by prepending their own value).
* **Per-identity, on spend actions only.** `pay_bill`, `schedule_bill`, and `pay_bill_batch`
  additionally rate-limit by the credential that authenticated the call — not the IP — so a
  leaked API key or OAuth token can't outrun the limit by rotating source addresses. This runs
  *after* the PIN check: the escalating PIN lockout only triggers on a *wrong* PIN, so on its own
  it does nothing to slow a run of *correct* calls.

## MCP / A2A

| Scope | Limit | Window |
|---|---|---|
| Every MCP tool call (per IP) | 60 | 60s |
| Every A2A call (per IP) | 60 | 60s |
| `pay_bill` (per credential) | 10 | 60s |
| `schedule_bill` (per credential) | 5 | 60s |
| `pay_bill_batch` (per credential) | 5 | 60s |

## OAuth 2.1

| Scope | Limit | Window |
|---|---|---|
| `GET /authorize` | 40 | 300s |
| Consent-form submission | 15 | 300s |
| Token exchange | 60 | 300s |
| Dynamic client registration | 20 | 300s |

## Everything else

Chat turns, account/OTP verification, schedules, and provider lookups (bank resolution, the
international catalogue) all carry their own per-IP limits too — see `src/lib/rateLimit.ts` and
its call sites in the source for the exhaustive list if you're integrating against a surface not
listed above.

## Response shape

A limited call returns **HTTP 429** with a `Retry-After` header:

{% code title="429 response body" %}
```json
{
  "success": false,
  "error": "Too many requests. Please slow down and try again shortly."
}
```
{% endcode %}

## Mechanics

A Postgres-backed fixed window, incremented atomically inside the database to close a race where
concurrent requests could all read "under limit" before any of them writes, falling back to a
non-atomic read-modify-write if that isn't deployed.

{% hint style="warning" %}
**Fails open, not closed.** If the rate-limit table or its atomic-increment function is
unreachable, the request is allowed rather than taking the whole API down. Rate limiting is an
abuse control, not an auth control, and must never become a single point of failure.
{% endhint %}
